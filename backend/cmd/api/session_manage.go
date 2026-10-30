package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/aws/aws-lambda-go/events"
)

func sessionRevision(s Session) int {
	if s.Revision < 1 {
		return 1
	}
	return s.Revision
}

func renameSession(ctx context.Context, store recordStore, user string, session Session, body []byte) events.APIGatewayV2HTTPResponse {
	var in struct {
		Categories *[]string `json:"categories"`
		Name       string    `json:"name"`
		Revision   int       `json:"revision"`
	}
	if json.Unmarshal(body, &in) != nil {
		return cloudError(400, "Enter a session name.")
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || utf8.RuneCountInString(in.Name) > 80 {
		return cloudError(400, "Session names must contain 1–80 characters.")
	}
	if in.Revision != sessionRevision(session) {
		return storeError(errConflict)
	}
	expected := sessionRevision(session)
	if in.Categories != nil {
		if len(*in.Categories) > 24 {
			return cloudError(400, "Use at most 24 custom categories.")
		}
		for _, c := range *in.Categories {
			if strings.TrimSpace(c) == "" || utf8.RuneCountInString(c) > 60 || c == "Trash" || c == "Waiting" || c == "Needs attention" || c == "View all" {
				return cloudError(400, "Invalid category.")
			}
		}
		session.Categories = *in.Categories
	}
	session.Name = in.Name
	session.Revision = expected + 1
	if err := saveRecord(ctx, store, "USER#"+user, "SESSION#"+session.ID, session, session.Revision, expected); err != nil {
		return storeError(err)
	}
	return apiJSON(200, session)
}

// Leave a deletion marker until every known photo and both objects are removed.
// A failed/interrupted cleanup can be retried without exposing a partial session.
func deleteSession(ctx context.Context, store recordStore, user string, session Session) events.APIGatewayV2HTTPResponse {
	if !session.Deleting {
		expected := sessionRevision(session)
		session.Deleting = true
		session.Revision = expected + 1
		if err := saveRecord(ctx, store, "USER#"+user, "SESSION#"+session.ID, session, session.Revision, expected); err != nil {
			return storeError(err)
		}
	}
	owner := sessionOwner(user, session.ID)
	records, err := store.List(ctx, owner, "PHOTO#")
	if err != nil {
		return storeError(err)
	}
	for index, data := range records {
		if index >= 20 {
			return apiJSON(202, map[string]bool{"deleting": true})
		}
		var photo Photo
		if json.Unmarshal(data, &photo) != nil || !resourceID.MatchString(photo.ID) {
			return storeError(fmt.Errorf("invalid stored photo"))
		}
		for _, kind := range []string{"original", "prepared.jpg"} {
			if err := store.RemoveObject(ctx, photoKey(user, session.ID, photo.ID, kind)); err != nil {
				return storeError(err)
			}
		}
		if err := store.Delete(ctx, owner, "PHOTO#"+photo.ID); err != nil {
			return storeError(err)
		}
	}
	// Jobs are removed before deleting the parent; late workers cannot recreate them.
	jobs, err := store.List(ctx, owner, "JOB#")
	if err != nil {
		return storeError(err)
	}
	for i, data := range jobs {
		if i >= 20 {
			return apiJSON(202, map[string]bool{"deleting": true})
		}
		var job ClassificationJob
		if json.Unmarshal(data, &job) != nil || !resourceID.MatchString(job.ID) {
			return storeError(fmt.Errorf("invalid classification job"))
		}
		if err := store.Delete(ctx, owner, "JOB#"+job.ID); err != nil {
			return storeError(err)
		}
	}
	// Hash reservations live in the same session partition and must leave with it.
	hashes, err := store.List(ctx, owner, "HASH#")
	if err != nil {
		return storeError(err)
	}
	for i, data := range hashes {
		if i >= 20 {
			return apiJSON(202, map[string]bool{"deleting": true})
		}
		var claim photoHashClaim
		if json.Unmarshal(data, &claim) != nil {
			return storeError(fmt.Errorf("invalid hash reservation"))
		}
		if !strings.HasPrefix(claim.Key, "HASH#") {
			return storeError(fmt.Errorf("invalid hash reservation key"))
		}
		if err := store.Delete(ctx, owner, claim.Key); err != nil {
			return storeError(err)
		}
	}
	if err := store.Delete(ctx, "USER#"+user, "SESSION#"+session.ID); err != nil {
		return storeError(err)
	}
	return apiJSON(200, map[string]bool{"deleted": true})
}

func saveSessionPhoto(ctx context.Context, store recordStore, user string, session Session, p Photo, expected int) error {
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return store.PutPhoto(ctx, "USER#"+user, "SESSION#"+session.ID, sessionRevision(session), sessionOwner(user, session.ID), "PHOTO#"+p.ID, data, p.Revision, expected)
}
