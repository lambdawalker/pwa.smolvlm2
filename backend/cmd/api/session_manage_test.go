package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-lambda-go/events"
	"strings"
	"testing"
)

func TestManageSessionsAndDeletePhotos(t *testing.T) {
	t.Setenv("COGNITO_CLIENT_ID", "client")
	t.Setenv("COGNITO_POOL_ID", "pool")
	oldOwner, oldFactory := accountOwner, storeFactory
	defer func() { accountOwner = oldOwner; storeFactory = oldFactory }()
	user := "alice"
	accountOwner = func(context.Context, events.APIGatewayV2HTTPRequest) (string, error) {
		if user == "" {
			return "", errors.New("no login")
		}
		return user, nil
	}
	store := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	storeFactory = func(context.Context) (recordStore, error) { return store, nil }
	call := func(method, path string, body any) events.APIGatewayV2HTTPResponse {
		b, _ := json.Marshal(body)
		r := events.APIGatewayV2HTTPRequest{RawPath: "/api/sessions" + path, Body: string(b)}
		r.RequestContext.HTTP.Method = method
		return sessionRoute(context.Background(), r)
	}
	response := call("POST", "", map[string]string{"name": "Phone visit"})
	var session Session
	json.Unmarshal([]byte(response.Body), &session)
	if response.StatusCode != 201 || session.Revision != 1 {
		t.Fatal(response)
	}
	path := "/" + session.ID
	for _, name := range []string{" ", strings.Repeat("é", 81)} {
		if r := call("PATCH", path, map[string]any{"name": name, "revision": 1}); r.StatusCode != 400 {
			t.Fatal(r)
		}
	}
	renamed := call("PATCH", path, map[string]any{"name": "  Laptop visit  ", "revision": 1})
	if renamed.StatusCode != 200 {
		t.Fatal(renamed)
	}
	json.Unmarshal([]byte(renamed.Body), &session)
	if session.Name != "Laptop visit" || session.Revision != 2 {
		t.Fatal(session)
	}
	if r := call("PATCH", path, map[string]any{"name": "Stale", "revision": 1}); r.StatusCode != 409 {
		t.Fatal("stale rename accepted", r)
	}
	user = "bob"
	for _, method := range []string{"PATCH", "DELETE"} {
		if r := call(method, path, map[string]any{"name": "Other account", "revision": 2}); r.StatusCode != 404 {
			t.Fatal("cross-account change", r)
		}
	}
	user = ""
	if r := call("DELETE", path, nil); r.StatusCode != 401 {
		t.Fatal("anonymous deletion", r)
	}
	user = "alice"
	for i := 0; i < 25; i++ {
		photo := Photo{ID: fmt.Sprintf("%032x", i+1), Revision: 1, State: "done", Category: "Indoors"}
		if err := saveSessionPhoto(context.Background(), store, user, session, photo, 0); err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"original", "prepared.jpg"} {
			store.sizes[photoKey(user, session.ID, photo.ID, kind)] = 100
		}
	}
	// An unrelated session and object must survive cleanup.
	store.data["USER#alice/SESSION#unrelated"] = []byte(`{"name":"Keep"}`)
	store.sizes["users/bob/keep/original"] = 10
	if r := call("DELETE", path, nil); r.StatusCode != 202 {
		t.Fatal("expected batched deletion", r)
	}
	if r := call("GET", path, nil); r.StatusCode != 409 {
		t.Fatal("partially deleted session exposed", r)
	}
	if r := call("POST", path+"/photos", Photo{Mime: "image/jpeg", Bytes: 5}); r.StatusCode != 409 {
		t.Fatal("upload during deletion", r)
	}
	if err := saveSessionPhoto(context.Background(), store, user, session, Photo{ID: newID(), Revision: 1}, 0); !errors.Is(err, errConflict) {
		t.Fatal("late upload resurrected metadata", err)
	}
	if r := call("PATCH", path, map[string]any{"name": "Resurrect", "revision": 3}); r.StatusCode != 409 {
		t.Fatal(r)
	}
	if r := call("DELETE", path, nil); r.StatusCode != 200 {
		t.Fatal(r)
	}
	if photos, _ := store.List(context.Background(), sessionOwner(user, session.ID), "PHOTO#"); len(photos) != 0 {
		t.Fatal("photos remain", len(photos))
	}
	if len(store.sizes) != 1 || store.sizes["users/bob/keep/original"] != 10 {
		t.Fatal("incorrect object cleanup", store.sizes)
	}
	if r := call("GET", path, nil); r.StatusCode != 404 {
		t.Fatal("deleted session visible", r)
	}
	if store.data["USER#alice/SESSION#unrelated"] == nil {
		t.Fatal("deleted unrelated session")
	}
}

type interruptedRecords struct {
	*memoryRecords
	fail bool
}

func (s *interruptedRecords) RemoveObject(ctx context.Context, key string) error {
	if s.fail {
		return errors.New("storage interrupted")
	}
	return s.memoryRecords.RemoveObject(ctx, key)
}
func TestSessionDeletionCanResume(t *testing.T) {
	ctx := context.Background()
	store := &interruptedRecords{&memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}, true}
	session := Session{ID: newID(), Name: "Old session"}
	if err := saveRecord(ctx, store, "USER#alice", "SESSION#"+session.ID, session, 1, 0); err != nil {
		t.Fatal(err)
	}
	photo := Photo{ID: newID(), Revision: 1}
	if err := saveSessionPhoto(ctx, store, "alice", session, photo, 0); err != nil {
		t.Fatal(err)
	}
	if r := deleteSession(ctx, store, "alice", session); r.StatusCode != 503 {
		t.Fatal(r)
	}
	data, _ := store.Get(ctx, "USER#alice", "SESSION#"+session.ID)
	json.Unmarshal(data, &session)
	if !session.Deleting {
		t.Fatal("missing retry marker")
	}
	store.fail = false
	if r := deleteSession(ctx, store, "alice", session); r.StatusCode != 200 {
		t.Fatal(r)
	}
}
