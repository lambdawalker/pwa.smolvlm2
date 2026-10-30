package main

import (
	"context"
	"encoding/json"
	"github.com/aws/aws-lambda-go/events"
	"strings"
	"testing"
)

func TestPhotoHashesDeduplicateAndBackfill(t *testing.T) {
	t.Setenv("COGNITO_CLIENT_ID", "client")
	t.Setenv("COGNITO_POOL_ID", "pool")
	oldOwner, oldFactory := accountOwner, storeFactory
	defer func() { accountOwner = oldOwner; storeFactory = oldFactory }()
	accountOwner = func(context.Context, events.APIGatewayV2HTTPRequest) (string, error) { return "alice", nil }
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	storeFactory = func(context.Context) (recordStore, error) { return m, nil }
	call := func(method, path string, value any) events.APIGatewayV2HTTPResponse {
		body, _ := json.Marshal(value)
		req := events.APIGatewayV2HTTPRequest{RawPath: "/api/sessions" + path, Body: string(body)}
		req.RequestContext.HTTP.Method = method
		return sessionRoute(context.Background(), req)
	}
	var session Session
	r := call("POST", "", map[string]string{"name": "Visit"})
	json.Unmarshal([]byte(r.Body), &session)
	pair := Photo{Mime: "image/jpeg", Bytes: 100, SourceHash: strings.Repeat("a", 64), DHash: "0000000000000000", HashVersion: photoHashVersion}
	upload := func(p Photo) Photo {
		t.Helper()
		r := call("POST", "/"+session.ID+"/photos", p)
		if r.StatusCode != 201 {
			t.Fatal(r)
		}
		var out struct {
			Photo Photo `json:"photo"`
		}
		json.Unmarshal([]byte(r.Body), &out)
		return out.Photo
	}
	first := upload(pair)
	if r := call("POST", "/"+session.ID+"/photos", pair); r.StatusCode != 409 {
		t.Fatal("concurrent duplicate upload must not reserve another photo", r)
	}
	key := photoKey("alice", session.ID, first.ID, "original")
	m.sizes[key] = 100
	m.sizes[photoKey("alice", session.ID, first.ID, "prepared.jpg")] = 40
	m.data["SHA#"+key] = []byte(pair.SourceHash)
	if r := call("PATCH", "/"+session.ID+"/photos/"+first.ID, Photo{Revision: 1, State: "pending"}); r.StatusCode != 200 {
		t.Fatal(r)
	}
	if r := call("POST", "/"+session.ID+"/photos", pair); r.StatusCode != 200 || !strings.Contains(r.Body, `"duplicate":true`) {
		t.Fatal("duplicate must avoid issuing upload URLs", r)
	}
	other := pair
	other.DHash = "8000000000000000"
	second := upload(other)
	if p := second; p.ID == first.ID {
		t.Fatal("different secondary hashes must not deduplicate")
	}
	legacy := upload(Photo{Mime: "image/jpeg", Bytes: 100})
	key = photoKey("alice", session.ID, legacy.ID, "original")
	m.sizes[key] = 100
	m.sizes[photoKey("alice", session.ID, legacy.ID, "prepared.jpg")] = 40
	if r := call("PATCH", "/"+session.ID+"/photos/"+legacy.ID, Photo{Revision: 1, State: "pending"}); r.StatusCode != 200 {
		t.Fatal(r)
	}
	m.data["SHA#"+key] = []byte(pair.SourceHash)
	r = call("POST", "/"+session.ID+"/photos/"+legacy.ID+"/hashes", pair)
	if r.StatusCode != 200 || !strings.Contains(r.Body, `"duplicateOf":"`+first.ID+`"`) {
		t.Fatal("backfill must report duplicates without removing photos", r)
	}
	stored, _ := m.Get(context.Background(), sessionOwner("alice", session.ID), "PHOTO#"+legacy.ID)
	var indexed Photo
	json.Unmarshal(stored, &indexed)
	if !indexed.SHA256Verified || indexed.State != "pending" {
		t.Fatal(indexed)
	}
	// Already stored duplicates can be cleaned up reversibly, retaining a classified copy.
	if r := call("PATCH", "/"+session.ID+"/photos/"+first.ID, Photo{Revision: 2, State: "done", Category: "Indoors", Description: "Keep this result."}); r.StatusCode != 200 {
		t.Fatal(r)
	}
	r = call("POST", "/"+session.ID+"/deduplicate", nil)
	if r.StatusCode != 200 || !strings.Contains(r.Body, `"moved":1`) {
		t.Fatal("existing duplicates not moved to Trash", r)
	}
	if !strings.Contains(r.Body, `"undoPhotos":[{"before":`) {
		t.Fatal("cleanup must return snapshots for Undo", r)
	}
	kept, _ := m.Get(context.Background(), sessionOwner("alice", session.ID), "PHOTO#"+first.ID)
	if !strings.Contains(string(kept), `"description":"Keep this result."`) || !strings.Contains(string(kept), `"state":"done"`) {
		t.Fatal("categorized copy was not retained")
	}
	removed, _ := m.Get(context.Background(), sessionOwner("alice", session.ID), "PHOTO#"+legacy.ID)
	if !strings.Contains(string(removed), `"state":"trash"`) {
		t.Fatal("duplicate not recoverable from Trash")
	}
	if r := call("POST", "/"+session.ID+"/deduplicate", nil); !strings.Contains(r.Body, `"moved":0`) {
		t.Fatal("cleanup is not idempotent", r)
	}
	// Hash claims are checked against the original S3 bytes before publishing a photo.
	forged := pair
	forged.SourceHash = strings.Repeat("b", 64)
	bad := upload(forged)
	key = photoKey("alice", session.ID, bad.ID, "original")
	m.sizes[key] = 100
	m.sizes[photoKey("alice", session.ID, bad.ID, "prepared.jpg")] = 40
	m.data["SHA#"+key] = []byte(pair.SourceHash)
	if r := call("PATCH", "/"+session.ID+"/photos/"+bad.ID, Photo{Revision: 1, State: "pending"}); r.StatusCode != 400 {
		t.Fatal("forged SHA-256 accepted", r)
	}
	// Shredding frees the hash reservation but never reuses a deleted photo ID.
	key = photoKey("alice", session.ID, second.ID, "original")
	m.sizes[key] = 100
	m.sizes[photoKey("alice", session.ID, second.ID, "prepared.jpg")] = 40
	m.data["SHA#"+key] = []byte(pair.SourceHash)
	if r := call("PATCH", "/"+session.ID+"/photos/"+second.ID, Photo{Revision: 1, State: "pending"}); r.StatusCode != 200 {
		t.Fatal(r)
	}
	if r := call("DELETE", "/"+session.ID+"/photos/"+second.ID, map[string]bool{"permanent": true}); r.StatusCode != 200 {
		t.Fatal(r)
	}
	replacement := upload(other)
	if replacement.ID == second.ID {
		t.Fatal("re-upload reused a shredded identity")
	}
	// Large cleanup jobs advance in bounded, retryable batches.
	for i := 0; i < 26; i++ {
		p := Photo{ID: newID(), Mime: "image/jpeg", Bytes: 100, SourceHash: strings.Repeat("c", 64), DHash: "0000000000000000", HashVersion: photoHashVersion, SHA256Verified: true, State: "pending", Revision: 1}
		if i == 0 {
			p.State = "done"
			p.Category = "Outdoors"
		}
		if err := saveSessionPhoto(context.Background(), m, "alice", session, p, 0); err != nil {
			t.Fatal(err)
		}
	}
	if r := call("POST", "/"+session.ID+"/deduplicate", nil); r.StatusCode != 202 || !strings.Contains(r.Body, `"moved":20`) {
		t.Fatal("cleanup is not bounded", r)
	}
	if r := call("POST", "/"+session.ID+"/deduplicate", nil); r.StatusCode != 200 || !strings.Contains(r.Body, `"moved":5`) {
		t.Fatal("cleanup cannot resume", r)
	}
	for i := 0; i < 10; i++ {
		r = call("DELETE", "/"+session.ID, nil)
		if r.StatusCode == 200 {
			break
		}
		if r.StatusCode != 202 {
			t.Fatal(r)
		}
	}
	claims, _ := m.List(context.Background(), sessionOwner("alice", session.ID), "HASH#")
	if len(claims) != 0 {
		t.Fatal("session deletion leaked hash reservations")
	}

}
