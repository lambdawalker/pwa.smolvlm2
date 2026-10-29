package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/aws/aws-lambda-go/events"
	"strings"
	"testing"
	"time"
)

func TestTrashConflictsRestoreAndShred(t *testing.T) {
	t.Setenv("COGNITO_CLIENT_ID", "client")
	t.Setenv("COGNITO_POOL_ID", "pool")
	oldOwner, oldFactory := accountOwner, storeFactory
	defer func() { accountOwner = oldOwner; storeFactory = oldFactory }()
	user := "alice"
	accountOwner = func(context.Context, events.APIGatewayV2HTTPRequest) (string, error) { return user, nil }
	store := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	storeFactory = func(context.Context) (recordStore, error) { return store, nil }
	call := func(method, path string, body any) events.APIGatewayV2HTTPResponse {
		data, _ := json.Marshal(body)
		req := events.APIGatewayV2HTTPRequest{RawPath: "/api/sessions" + path, Body: string(data)}
		req.RequestContext.HTTP.Method = method
		return sessionRoute(context.Background(), req)
	}
	created := call("POST", "", map[string]string{"name": "Sync"})
	var session Session
	json.Unmarshal([]byte(created.Body), &session)
	p := Photo{ID: newID(), Revision: 1, State: "done", Category: "Indoors", Description: "A room."}
	if err := saveSessionPhoto(context.Background(), store, user, session, p, 0); err != nil {
		t.Fatal(err)
	}
	path := "/" + session.ID + "/photos/" + p.ID
	read := func(r events.APIGatewayV2HTTPResponse) Photo {
		t.Helper()
		if r.StatusCode != 200 {
			t.Fatal(r)
		}
		var photo Photo
		if err := json.Unmarshal([]byte(r.Body), &photo); err != nil {
			t.Fatal(err)
		}
		return photo
	}
	trashed := read(call("PATCH", path, Photo{Revision: 1, State: "trash"}))
	if trashed.State != "trash" || trashed.ExpiresAt < time.Now().Add(48*time.Hour-time.Second).Unix() {
		t.Fatal(trashed)
	}
	// Repeating a delete must not turn Trash into a false conflict.
	repeated := read(call("PATCH", path, Photo{Revision: 1, State: "trash"}))
	if repeated.State != "trash" || repeated.Revision != trashed.Revision {
		t.Fatal(repeated)
	}
	conflict := read(call("PATCH", path, Photo{Revision: 1, State: "done", Category: "Outdoors", Description: "A garden."}))
	if conflict.State != "review" || !conflict.Conflict || conflict.ExpiresAt != 0 || conflict.Category != "Outdoors" {
		t.Fatal(conflict)
	}
	resolved := read(call("PATCH", path, Photo{Revision: conflict.Revision, State: "done", Category: "Outdoors", Description: conflict.Description}))
	if resolved.Conflict || resolved.State != "done" {
		t.Fatal(resolved)
	}
	// Reverse order: an older delete following an edit also requires attention.
	conflict = read(call("PATCH", path, Photo{Revision: trashed.Revision, State: "trash"}))
	if conflict.State != "review" || !conflict.Conflict || conflict.Category != "Outdoors" {
		t.Fatal(conflict)
	}
	user = "bob"
	if r := call("PATCH", path, Photo{Revision: conflict.Revision, State: "trash"}); r.StatusCode != 404 {
		t.Fatal("cross-account Trash", r)
	}
	user = "alice"
	trashed = read(call("PATCH", path, Photo{Revision: conflict.Revision, State: "trash"}))
	restored := read(call("PATCH", path, Photo{Revision: trashed.Revision, State: "done", Category: "Documents", Description: "A page."}))
	if restored.ExpiresAt != 0 || restored.State != "done" {
		t.Fatal(restored)
	}
	legacy := read(call("DELETE", path, nil))
	if legacy.State != "trash" {
		t.Fatal("older clients must move photos to Trash", legacy)
	}
	conflict = read(call("PATCH", path, Photo{Revision: restored.Revision, State: "done", Category: "Indoors"}))
	if !conflict.Conflict {
		t.Fatal("expected stale edit conflict")
	}
	if r := call("DELETE", path, map[string]bool{"permanent": true}); r.StatusCode != 200 {
		t.Fatal(r)
	}
	if r := call("PATCH", path, Photo{Revision: restored.Revision, State: "done", Category: "Indoors"}); r.StatusCode != 404 {
		t.Fatal("shred must win", r)
	}
	if err := saveSessionPhoto(context.Background(), store, user, session, restored, restored.Revision); !errors.Is(err, errConflict) {
		t.Fatal("late write restored a shredded photo", err)
	}
}
func TestTrashExpiryAndFailedShredCleanup(t *testing.T) {
	ctx := context.Background()
	base := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	store := &interruptedRecords{base, false}
	session := Session{ID: newID(), Name: "Expiry", Revision: 1}
	if err := saveRecord(ctx, store, "USER#alice", "SESSION#"+session.ID, session, 1, 0); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	photo := Photo{ID: newID(), Revision: 1, State: "trash", ExpiresAt: now + 172800}
	if err := saveSessionPhoto(ctx, store, "alice", session, photo, 0); err != nil {
		t.Fatal(err)
	}
	key := photoKey("alice", session.ID, photo.ID, "original")
	base.sizes[key] = 100
	if err := purgeTrash(ctx, store, now+172799); err != nil {
		t.Fatal(err)
	}
	if base.sizes[key] != 100 {
		t.Fatal("photo purged before 48 hours")
	}
	if err := purgeTrash(ctx, store, now+172800); err != nil {
		t.Fatal(err)
	}
	if len(base.sizes) != 0 {
		t.Fatal("expired objects remain")
	}
	photo = Photo{ID: newID(), Revision: 1, State: "done"}
	if err := saveSessionPhoto(ctx, store, "alice", session, photo, 0); err != nil {
		t.Fatal(err)
	}
	store.fail = true
	if err := shredPhoto(ctx, store, "alice", session.ID, photo); err == nil {
		t.Fatal("expected cleanup interruption")
	}
	data, _ := store.Get(ctx, sessionOwner("alice", session.ID), "PHOTO#"+photo.ID)
	if !strings.Contains(string(data), `"state":"shredded"`) {
		t.Fatal("shred did not leave a permanent tombstone")
	}
	if err := saveSessionPhoto(ctx, store, "alice", session, photo, photo.Revision); !errors.Is(err, errConflict) {
		t.Fatal("edit won over shred")
	}
	store.fail = false
	if err := purgeTrash(ctx, store, now); err != nil {
		t.Fatal(err)
	}
	data, _ = store.Get(ctx, sessionOwner("alice", session.ID), "PHOTO#"+photo.ID)
	if data != nil {
		t.Fatal("failed shred was not cleaned up")
	}
}
func TestHTTPRequestsCannotTriggerScheduledCleanup(t *testing.T) {
	req := events.APIGatewayV2HTTPRequest{RawPath: "/internal/purge-trash"}
	req.RequestContext.HTTP.Method = "GET"
	r, err := handle(context.Background(), req)
	if err != nil || r.StatusCode != 404 {
		t.Fatal(r, err)
	}
}

type restoringRecords struct {
	*memoryRecords
	restored bool
}

func (s *restoringRecords) Put(ctx context.Context, o, k string, data []byte, revision, expected int) error {
	var p Photo
	json.Unmarshal(data, &p)
	if p.State == "shredded" && !s.restored {
		s.restored = true
		p.State = "done"
		p.ExpiresAt = 0
		p.Category = "Outdoors"
		p.Revision = expected + 1
		next, _ := json.Marshal(p)
		if err := s.memoryRecords.Put(ctx, o, k, next, p.Revision, expected); err != nil {
			return err
		}
		return errConflict
	}
	return s.memoryRecords.Put(ctx, o, k, data, revision, expected)
}
func TestRestoreRacingExpirySurvives(t *testing.T) {
	ctx := context.Background()
	base := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	store := &restoringRecords{base, false}
	sid := newID()
	photo := Photo{ID: newID(), State: "trash", ExpiresAt: 1, Revision: 1}
	data, _ := json.Marshal(photo)
	if err := base.Put(ctx, sessionOwner("alice", sid), "PHOTO#"+photo.ID, data, 1, 0); err != nil {
		t.Fatal(err)
	}
	key := photoKey("alice", sid, photo.ID, "original")
	base.sizes[key] = 123
	if err := purgeTrash(ctx, store, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	data, _ = base.Get(ctx, sessionOwner("alice", sid), "PHOTO#"+photo.ID)
	var restored Photo
	json.Unmarshal(data, &restored)
	if restored.State != "done" || base.sizes[key] != 123 {
		t.Fatal("concurrent restore was deleted", restored)
	}
}

func TestConditionalSessionReads(t *testing.T) {
	t.Setenv("COGNITO_CLIENT_ID", "client")
	t.Setenv("COGNITO_POOL_ID", "pool")
	oldOwner, oldFactory := accountOwner, storeFactory
	defer func() { accountOwner = oldOwner; storeFactory = oldFactory }()
	accountOwner = func(context.Context, events.APIGatewayV2HTTPRequest) (string, error) { return "alice", nil }
	store := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	storeFactory = func(context.Context) (recordStore, error) { return store, nil }
	ctx := context.Background()
	session := Session{ID: newID(), Name: "Version", Revision: 1}
	if err := saveRecord(ctx, store, "USER#alice", "SESSION#"+session.ID, session, 1, 0); err != nil {
		t.Fatal(err)
	}
	req := events.APIGatewayV2HTTPRequest{RawPath: "/api/sessions/" + session.ID}
	req.RequestContext.HTTP.Method = "GET"
	first := sessionRoute(ctx, req)
	etag := first.Headers["etag"]
	if first.StatusCode != 200 || etag == "" {
		t.Fatal(first)
	}
	req.Headers = map[string]string{"if-none-match": etag}
	if unchanged := sessionRoute(ctx, req); unchanged.StatusCode != 304 || unchanged.Body != "" {
		t.Fatal(unchanged)
	}
	p := Photo{ID: newID(), Revision: 1, State: "pending"}
	if err := saveSessionPhoto(ctx, store, "alice", session, p, 0); err != nil {
		t.Fatal(err)
	}
	changed := sessionRoute(ctx, req)
	if changed.StatusCode != 200 || changed.Headers["etag"] == etag {
		t.Fatal("new photo did not invalidate version", changed)
	}
}
