package main

import (
	"context"
	"encoding/json"
	"github.com/aws/aws-lambda-go/events"
	"strings"
	"time"
)

const trashRetention = 48 * time.Hour

type trashRecord struct {
	Owner, Key string
	Photo      Photo
}

func shredPhoto(ctx context.Context, store recordStore, user, sid string, p Photo) error {
	p.State = "shredded"
	p.Revision++
	p.UserRevision = p.Revision
	p.ExpiresAt = 0
	data, _ := json.Marshal(p)
	if err := store.MarkShredded(ctx, sessionOwner(user, sid), "PHOTO#"+p.ID, data); err != nil {
		return err
	}
	for _, kind := range []string{"original", "prepared.jpg"} {
		if err := store.RemoveObject(ctx, photoKey(user, sid, p.ID, kind)); err != nil {
			return err
		}
	}
	if err := releasePhotoHash(ctx, store, user, sid, p); err != nil {
		return err
	}
	return store.Delete(ctx, sessionOwner(user, sid), "PHOTO#"+p.ID)
}
func trashPhoto(ctx context.Context, store recordStore, user string, session Session, p Photo, in Photo) events.APIGatewayV2HTTPResponse {
	if p.State == "trash" {
		return apiJSON(200, p)
	}
	expected := p.Revision
	if in.Revision != p.Revision {
		p.State = "review"
		p.Conflict = true
		p.ExpiresAt = 0
	} else {
		p.State = "trash"
		p.Conflict = false
		p.ExpiresAt = time.Now().Add(trashRetention).Unix()
	}
	p.Revision++
	p.UserRevision = p.Revision
	p.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	if err := saveSessionPhoto(ctx, store, user, session, p, expected); err != nil {
		return storeError(err)
	}
	return apiJSON(200, p)
}
func purgeTrash(ctx context.Context, store recordStore, now int64) error {
	records, err := store.TrashCandidates(ctx, now)
	if err != nil {
		return err
	}
	for _, record := range records {
		parts := strings.Split(record.Owner, "#")
		if len(parts) != 4 || parts[0] != "USER" || parts[2] != "SESSION" || !resourceID.MatchString(parts[3]) {
			continue
		}
		data, err := store.Get(ctx, record.Owner, record.Key)
		if err != nil {
			return err
		}
		if data == nil {
			continue
		}
		var p Photo
		if json.Unmarshal(data, &p) != nil {
			continue
		}
		if p.State == "trash" && p.ExpiresAt > 0 && p.ExpiresAt <= now {
			expected := p.Revision
			p.State = "shredded"
			p.Revision++
			p.UserRevision = p.Revision
			data, _ = json.Marshal(p)
			if err := store.Put(ctx, record.Owner, record.Key, data, p.Revision, expected); err != nil {
				if err == errConflict {
					continue
				}
				return err
			}
		} else if p.State != "shredded" {
			continue
		}
		if err := shredPhoto(ctx, store, parts[1], parts[3], p); err != nil {
			return err
		}
	}
	return nil
}
