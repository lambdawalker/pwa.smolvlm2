package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/aws/aws-lambda-go/events"
	"regexp"
	"sort"
	"time"
)

const photoHashVersion = "dhash-8-v1"

var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var dHashPattern = regexp.MustCompile(`^[a-f0-9]{16}$`)

func validPhotoHashes(p Photo) bool {
	return shaPattern.MatchString(p.SourceHash) && dHashPattern.MatchString(p.DHash) && p.HashVersion == photoHashVersion
}
func samePhotoHashes(a, b Photo) bool {
	return validPhotoHashes(a) && validPhotoHashes(b) && a.SourceHash == b.SourceHash && a.DHash == b.DHash
}
func findDuplicatePhoto(ctx context.Context, store recordStore, owner string, p Photo) (*Photo, error) {
	records, err := store.List(ctx, owner, "PHOTO#")
	if err != nil {
		return nil, err
	}
	var duplicate *Photo
	for _, data := range records {
		var other Photo
		if json.Unmarshal(data, &other) != nil {
			continue
		}
		if other.ID != p.ID && other.SHA256Verified && other.State != "uploading" && other.State != "shredded" && samePhotoHashes(p, other) {
			if duplicate == nil || other.ID < duplicate.ID {
				copy := other
				duplicate = &copy
			}
		}
	}
	return duplicate, nil
}
func duplicatePhotoResponse(p Photo) events.APIGatewayV2HTTPResponse {
	return apiJSON(200, map[string]any{"duplicate": true, "photo": p})
}
func verifyOriginalHash(ctx context.Context, store recordStore, user, sid string, p Photo) error {
	actual, size, err := store.ObjectSHA256(ctx, photoKey(user, sid, p.ID, "original"))
	if err != nil {
		return err
	}
	if size != p.Bytes || actual != p.SourceHash {
		return errors.New("original hash mismatch")
	}
	return nil
}

// Metadata-only migration: never changes category, descriptions, Trash, or file keys.
func backfillPhotoHashes(ctx context.Context, store recordStore, user string, session Session, pid string, body []byte) events.APIGatewayV2HTTPResponse {
	var in Photo
	if json.Unmarshal(body, &in) != nil || !validPhotoHashes(in) {
		return cloudError(400, "Invalid image hashes.")
	}
	data, err := store.Get(ctx, sessionOwner(user, session.ID), "PHOTO#"+pid)
	if err != nil {
		return storeError(err)
	}
	if data == nil {
		return cloudError(404, "Photo not found.")
	}
	var p Photo
	if json.Unmarshal(data, &p) != nil {
		return storeError(errors.New("invalid photo"))
	}
	if p.State == "shredded" {
		return cloudError(404, "Photo permanently removed.")
	}
	if p.State == "uploading" {
		return cloudError(409, "Wait for the upload to finish before indexing.")
	}

	needsHashes := !p.SHA256Verified || !validPhotoHashes(p)
	expected := p.Revision
	if needsHashes {
		p.SourceHash = in.SourceHash
		p.DHash = in.DHash
		p.HashVersion = in.HashVersion
		if err := verifyOriginalHash(ctx, store, user, session.ID, p); err != nil {
			return cloudError(409, "Could not verify the original image bytes. Retry indexing.")
		}
		p.SHA256Verified = true
	}
	duplicate, err := reservePhotoHash(ctx, store, user, session, &p)
	if err != nil {
		return storeError(err)
	}
	if needsHashes {
		p.Revision++
		p.Updated = time.Now().UTC().Format(time.RFC3339Nano)
		if err := saveSessionPhoto(ctx, store, user, session, p, expected); err != nil {
			return storeError(err)
		}
	}

	result := map[string]any{"photo": p, "updated": needsHashes}
	if duplicate != nil {
		result["duplicateOf"] = duplicate.ID
	}
	return apiJSON(200, result)
}

// Keep the hash reservation separate from photo IDs: a re-upload after shredding
// must get a new identity so stale clients can never delete the replacement.
type photoHashClaim struct {
	Key        string `json:"key"`
	PhotoID    string `json:"photoId"`
	Revision   int    `json:"revision"`
	LeaseUntil int64  `json:"leaseUntil"`
}

func photoHashKey(p Photo) string {
	return "HASH#" + p.HashVersion + ":" + p.SourceHash + ":" + p.DHash
}
func reservePhotoHash(ctx context.Context, store recordStore, user string, session Session, p *Photo) (*Photo, error) {
	owner, key := sessionOwner(user, session.ID), photoHashKey(*p)
	data, err := store.Get(ctx, owner, key)
	if err != nil {
		return nil, err
	}
	previous := photoHashClaim{}
	if data != nil && json.Unmarshal(data, &previous) != nil {
		return nil, errors.New("invalid hash reservation")
	}
	if previous.PhotoID == p.ID {
		return nil, nil
	}
	if previous.PhotoID != "" {
		record, err := store.Get(ctx, owner, "PHOTO#"+previous.PhotoID)
		if err != nil {
			return nil, err
		}
		if record != nil {
			var existing Photo
			if json.Unmarshal(record, &existing) != nil {
				return nil, errors.New("invalid hash photo")
			}
			if existing.SHA256Verified && existing.State != "uploading" && existing.State != "shredded" && samePhotoHashes(*p, existing) {
				return &existing, nil
			}
			if existing.State == "uploading" && previous.LeaseUntil < time.Now().Unix() {
				// Retire an abandoned upload with a revision check before releasing its claim.
				expected := existing.Revision
				existing.State = "shredded"
				existing.Revision++
				if err := saveSessionPhoto(ctx, store, user, session, existing, expected); err != nil {
					return nil, err
				}
				if err := shredPhoto(ctx, store, user, session.ID, existing); err != nil {
					return nil, err
				}
				// Shredding increments the claim revision; retry with fresh metadata.
				return nil, errConflict
			}
			if existing.State != "shredded" {
				return nil, errConflict
			}
		} else if previous.LeaseUntil > time.Now().Unix() {
			return nil, errConflict
		}
	}
	next := photoHashClaim{Key: key, PhotoID: p.ID, Revision: previous.Revision + 1, LeaseUntil: time.Now().Add(10 * time.Minute).Unix()}
	encoded, _ := json.Marshal(next)
	if err := store.PutPhoto(ctx, "USER#"+user, "SESSION#"+session.ID, sessionRevision(session), owner, key, encoded, next.Revision, previous.Revision); err != nil {
		return nil, err
	}
	return nil, nil
}
func releasePhotoHash(ctx context.Context, store recordStore, user, sid string, p Photo) error {
	if !validPhotoHashes(p) {
		return nil
	}
	owner, key := sessionOwner(user, sid), photoHashKey(p)
	data, err := store.Get(ctx, owner, key)
	if err != nil || data == nil {
		return err
	}
	var claim photoHashClaim
	if json.Unmarshal(data, &claim) != nil {
		return errors.New("invalid hash reservation")
	}
	if claim.PhotoID != p.ID {
		return nil
	}
	expected := claim.Revision
	claim.PhotoID = ""
	// Existing duplicates are preserved by migration. Keep one as the canonical
	// target if the original canonical photo is shredded.
	duplicate, err := findDuplicatePhoto(ctx, store, owner, p)
	if err != nil {
		return err
	}
	if duplicate != nil {
		claim.PhotoID = duplicate.ID
	}
	claim.LeaseUntil = 0
	claim.Revision++
	encoded, _ := json.Marshal(claim)
	err = store.Put(ctx, owner, key, encoded, claim.Revision, expected)
	if errors.Is(err, errConflict) {
		return nil
	}
	return err
}

// Cleanup is explicitly requested and reversible. Keep a categorized copy first;
// do not collapse missing/unverified hashes or touch photos already in Trash.
func trashDuplicatePhotos(ctx context.Context, store recordStore, user string, session Session) events.APIGatewayV2HTTPResponse {
	records, err := store.List(ctx, sessionOwner(user, session.ID), "PHOTO#")
	if err != nil {
		return storeError(err)
	}
	groups := map[string][]Photo{}
	unindexed := 0
	for _, data := range records {
		var p Photo
		if json.Unmarshal(data, &p) != nil {
			continue
		}
		if p.State == "shredded" || p.State == "uploading" {
			continue
		}
		if !p.SHA256Verified || !validPhotoHashes(p) {
			unindexed++
			continue
		}
		if p.State != "trash" {
			key := photoHashKey(p)
			groups[key] = append(groups[key], p)
		}
	}
	extras := []Photo{}
	for _, group := range groups {
		sort.Slice(group, func(i, j int) bool {
			if (group[i].State == "done") != (group[j].State == "done") {
				return group[i].State == "done"
			}
			return group[i].ID < group[j].ID
		})
		if len(group) > 1 {
			extras = append(extras, group[1:]...)
		}
	}
	sort.Slice(extras, func(i, j int) bool { return extras[i].ID < extras[j].ID })
	moved := 0
	for _, p := range extras {
		if moved >= 20 {
			break
		}
		response := trashPhoto(ctx, store, user, session, p, Photo{Revision: p.Revision})
		if response.StatusCode != 200 {
			return response
		}
		moved++
	}
	status := 200
	if len(extras) > moved {
		status = 202
	}
	return apiJSON(status, map[string]any{"moved": moved, "remaining": len(extras) > moved, "unindexed": unindexed})
}
