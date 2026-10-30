package main

import (
	"context"
	"encoding/json"
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
