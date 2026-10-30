package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestCustomCategoriesPersistAndRejectReservedNames(t *testing.T) {
	ctx := context.Background()
	store := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	s := Session{ID: "s", Name: "Inspection", Revision: 1}
	if err := saveRecord(ctx, store, "USER#u", "SESSION#s", s, 1, 0); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"name":"Inspection","revision":1,"categories":["Plumbing","Electrical"]}`)
	response := renameSession(ctx, store, "u", s, body)
	if response.StatusCode != 200 {
		t.Fatal(response)
	}
	var saved Session
	json.Unmarshal([]byte(response.Body), &saved)
	if len(saved.Categories) != 2 || saved.Categories[0] != "Plumbing" {
		t.Fatal(saved)
	}
	response = renameSession(ctx, store, "u", saved, []byte(`{"name":"Inspection","revision":2,"categories":["Trash"]}`))
	if response.StatusCode != 400 {
		t.Fatal(response)
	}
	category, description := classificationResult(`{"category":"Plumbing","description":"A leaking pipe."}`)
	if category != "Plumbing" || description != "A leaking pipe." {
		t.Fatal(category, description)
	}
}

func TestCascadeQueuesCompletedPhotosAndSkipsTrash(t *testing.T) {
	ctx := context.Background()
	store := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	session := Session{ID: newID(), Revision: 1}
	if err := saveRecord(ctx, store, "USER#u", "SESSION#"+session.ID, session, 1, 0); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"done", "review", "trash", "uploading"} {
		p := Photo{ID: newID(), State: state, Revision: 1, Uploaded: "2026-10-30T12:00:00Z"}
		if err := saveSessionPhoto(ctx, store, "u", session, p, 0); err != nil {
			t.Fatal(err)
		}
	}
	body := []byte(`{"all":true,"cascadeId":"run-one","consent":true,"prompt":"New classification prompt"}`)
	r := queuePendingPhotos(ctx, store, "u", session, body)
	if r.StatusCode != 200 {
		t.Fatal(r)
	}
	var result struct {
		Photos []Photo `json:"photos"`
	}
	json.Unmarshal([]byte(r.Body), &result)
	if len(result.Photos) != 2 {
		t.Fatal(r.Body)
	}
	for _, p := range result.Photos {
		if p.Uploaded != "2026-10-30T12:00:00Z" || p.JobID == "" {
			t.Fatal(p)
		}
	}
	r = queuePendingPhotos(ctx, store, "u", session, body)
	json.Unmarshal([]byte(r.Body), &result)
	if len(result.Photos) != 0 {
		t.Fatal("retry must not queue twice", r.Body)
	}
	r = queuePendingPhotos(ctx, store, "u", session, []byte(strings.ReplaceAll(string(body), "run-one", "run-two")))
	json.Unmarshal([]byte(r.Body), &result)
	if len(result.Photos) != 2 {
		t.Fatal("a new cascade must reprocess matching prompts", r.Body)
	}
}
