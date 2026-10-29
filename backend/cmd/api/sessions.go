package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/aws/aws-lambda-go/events"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const maxOriginalBytes = 25 << 20

var resourceID = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Session struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Created string `json:"created"`
}
type Photo struct {
	ID          string `json:"id"`
	Mime        string `json:"mime"`
	Bytes       int64  `json:"bytes"`
	State       string `json:"state"`
	Category    string `json:"category"`
	Description string `json:"description"`
	RawOutput   string `json:"rawOutput"`
	Revision    int    `json:"revision"`
	Updated     string `json:"updated"`
	OriginalURL string `json:"originalUrl,omitempty"`
	PreparedURL string `json:"preparedUrl,omitempty"`
}

func newID() string {
	var v [16]byte
	if _, e := rand.Read(v[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(v[:])
}
func sessionOwner(u, s string) string   { return "USER#" + u + "#SESSION#" + s }
func photoKey(u, s, p, k string) string { return "users/" + u + "/" + s + "/" + p + "/" + k }
func saveRecord(ctx context.Context, store recordStore, o, k string, v any, r, expected int) error {
	data, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return store.Put(ctx, o, k, data, r, expected)
}
func storeError(e error) events.APIGatewayV2HTTPResponse {
	if errors.Is(e, errConflict) {
		return cloudError(409, "This photo changed on another device. Refresh the session before retrying.")
	}
	return cloudError(503, "Session storage is temporarily unavailable. Please retry.")
}
func sessionRoute(ctx context.Context, req events.APIGatewayV2HTTPRequest) events.APIGatewayV2HTTPResponse {
	if !accountsEnabled() {
		return cloudError(503, "Accounts and shared sessions are not configured.")
	}
	user, e := accountOwner(ctx, req)
	if e != nil {
		return cloudError(401, "Sign in to access your sessions.")
	}
	store, e := storeFactory(ctx)
	if e != nil {
		return storeError(e)
	}
	method := req.RequestContext.HTTP.Method
	path := strings.Split(strings.Trim(req.RawPath, "/"), "/")
	body := []byte(req.Body)
	if len(body) > 256<<10 || req.IsBase64Encoded {
		return cloudError(400, "Invalid session request.")
	}
	if len(path) == 2 {
		if method == "GET" {
			records, e := store.List(ctx, "USER#"+user, "SESSION#")
			if e != nil {
				return storeError(e)
			}
			sessions := []Session{}
			for _, d := range records {
				var v Session
				if json.Unmarshal(d, &v) == nil {
					sessions = append(sessions, v)
				}
			}
			return apiJSON(200, map[string]any{"sessions": sessions})
		}
		if method == "POST" {
			var in struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(body, &in) != nil {
				return cloudError(400, "Enter a session name.")
			}
			in.Name = strings.TrimSpace(in.Name)
			if in.Name == "" || utf8.RuneCountInString(in.Name) > 80 {
				return cloudError(400, "Session names must contain 1–80 characters.")
			}
			v := Session{newID(), in.Name, time.Now().UTC().Format(time.RFC3339Nano)}
			if e := saveRecord(ctx, store, "USER#"+user, "SESSION#"+v.ID, v, 1, 0); e != nil {
				return storeError(e)
			}
			return apiJSON(201, v)
		}
		return cloudError(405, "Method not allowed.")
	}
	if len(path) < 3 || !resourceID.MatchString(path[2]) {
		return cloudError(404, "Session not found.")
	}
	sid := path[2]
	data, e := store.Get(ctx, "USER#"+user, "SESSION#"+sid)
	if e != nil {
		return storeError(e)
	}
	if data == nil {
		return cloudError(404, "Session not found.")
	}
	var session Session
	if json.Unmarshal(data, &session) != nil {
		return storeError(errors.New("invalid session"))
	}
	owner := sessionOwner(user, sid)
	if len(path) == 3 && method == "GET" {
		records, e := store.List(ctx, owner, "PHOTO#")
		if e != nil {
			return storeError(e)
		}
		photos := []Photo{}
		for _, d := range records {
			var p Photo
			if json.Unmarshal(d, &p) != nil {
				continue
			}
			p.OriginalURL, e = store.URL(ctx, "GET", photoKey(user, sid, p.ID, "original"), p.Mime)
			if e != nil {
				return storeError(e)
			}
			p.PreparedURL, e = store.URL(ctx, "GET", photoKey(user, sid, p.ID, "prepared.jpg"), "image/jpeg")
			if e != nil {
				return storeError(e)
			}
			photos = append(photos, p)
		}
		return apiJSON(200, map[string]any{"session": session, "photos": photos})
	}
	if len(path) == 4 && path[3] == "photos" && method == "POST" {
		var p Photo
		if json.Unmarshal(body, &p) != nil {
			return cloudError(400, "Invalid photo.")
		}
		switch p.Mime {
		case "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif":
		default:
			return cloudError(400, "Use JPEG, PNG, WebP, GIF or HEIC photos.")
		}
		if p.Bytes <= 0 || p.Bytes > maxOriginalBytes {
			return cloudError(413, "Photos must be 25 MB or smaller.")
		}
		p.ID = newID()
		p.State = "uploading"
		p.Category = ""
		p.Description = ""
		p.RawOutput = ""
		p.Revision = 1
		p.Updated = time.Now().UTC().Format(time.RFC3339Nano)
		p.OriginalURL = ""
		p.PreparedURL = ""
		original, e := store.URL(ctx, "PUT", photoKey(user, sid, p.ID, "original"), p.Mime)
		if e != nil {
			return storeError(e)
		}
		prepared, e := store.URL(ctx, "PUT", photoKey(user, sid, p.ID, "prepared.jpg"), "image/jpeg")
		if e != nil {
			return storeError(e)
		}
		if e := saveRecord(ctx, store, owner, "PHOTO#"+p.ID, p, 1, 0); e != nil {
			return storeError(e)
		}
		return apiJSON(201, map[string]any{"photo": p, "originalUploadUrl": original, "preparedUploadUrl": prepared})
	}
	if len(path) == 5 && path[3] == "photos" && resourceID.MatchString(path[4]) {
		pid := path[4]
		data, e := store.Get(ctx, owner, "PHOTO#"+pid)
		if e != nil {
			return storeError(e)
		}
		if data == nil {
			return cloudError(404, "Photo not found.")
		}
		var p Photo
		if json.Unmarshal(data, &p) != nil {
			return storeError(errors.New("invalid photo"))
		}
		if method == "DELETE" {
			for _, k := range []string{"original", "prepared.jpg"} {
				if e := store.RemoveObject(ctx, photoKey(user, sid, pid, k)); e != nil {
					return storeError(e)
				}
			}
			if e := store.Delete(ctx, owner, "PHOTO#"+pid); e != nil {
				return storeError(e)
			}
			return apiJSON(200, map[string]bool{"deleted": true})
		}
		if method == "PATCH" {
			var in Photo
			if json.Unmarshal(body, &in) != nil {
				return cloudError(400, "Invalid photo update.")
			}
			if in.Revision != p.Revision {
				return storeError(errConflict)
			}
			switch in.State {
			case "pending", "done", "review", "error":
			default:
				return cloudError(400, "Invalid photo state.")
			}
			if utf8.RuneCountInString(in.Description) > 180 || len(in.RawOutput) > 8192 {
				return cloudError(400, "Photo text is too long.")
			}
			if in.State == "done" && in.Category != "Indoors" && in.Category != "Outdoors" && in.Category != "Documents" && in.Category != "Computer screens" {
				return cloudError(400, "Choose a category.")
			}
			if p.State == "uploading" {
				original, e := store.Size(ctx, photoKey(user, sid, pid, "original"))
				if e != nil || original != p.Bytes {
					return cloudError(409, "Original upload is incomplete.")
				}
				prepared, e := store.Size(ctx, photoKey(user, sid, pid, "prepared.jpg"))
				if e != nil || prepared <= 0 || prepared > 512<<10 {
					return cloudError(409, "Prepared upload is incomplete.")
				}
			}
			p.State = in.State
			p.Category = in.Category
			p.Description = in.Description
			p.RawOutput = in.RawOutput
			p.Revision++
			p.Updated = time.Now().UTC().Format(time.RFC3339Nano)
			if e := saveRecord(ctx, store, owner, "PHOTO#"+pid, p, p.Revision, in.Revision); e != nil {
				return storeError(e)
			}
			return apiJSON(200, p)
		}
	}
	return cloudError(405, "Method not allowed.")
}
