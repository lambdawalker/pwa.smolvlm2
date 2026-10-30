package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/aws/aws-lambda-go/events"
	"io"
	"net/http"
	"strings"
	"testing"
)

type memoryRecords struct {
	data  map[string][]byte
	rev   map[string]int
	sizes map[string]int64
}

func (m *memoryRecords) Get(_ context.Context, o, k string) ([]byte, error) {
	return m.data[o+"/"+k], nil
}
func (m *memoryRecords) List(_ context.Context, o, p string) ([][]byte, error) {
	out := [][]byte{}
	for k, v := range m.data {
		if strings.HasPrefix(k, o+"/"+p) {
			out = append(out, v)
		}
	}
	return out, nil
}
func (m *memoryRecords) Put(_ context.Context, o, k string, b []byte, r, e int) error {
	key := o + "/" + k
	if m.rev[key] != e {
		return errConflict
	}
	m.data[key] = b
	m.rev[key] = r
	return nil
}
func (m *memoryRecords) Delete(_ context.Context, o, k string) error {
	delete(m.data, o+"/"+k)
	delete(m.rev, o+"/"+k)
	return nil
}
func (m *memoryRecords) URL(_ context.Context, method, key, mime string) (string, error) {
	return "https://private.example/" + key, nil
}
func (m *memoryRecords) Size(_ context.Context, k string) (int64, error) { return m.sizes[k], nil }
func (m *memoryRecords) RemoveObject(_ context.Context, k string) error {
	delete(m.sizes, k)
	return nil
}
func TestPrivateSessions(t *testing.T) {
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
	created := call("POST", "", map[string]string{"name": "Site visit"})
	if created.StatusCode != 201 {
		t.Fatal(created)
	}
	var session Session
	json.Unmarshal([]byte(created.Body), &session)
	user = "bob"
	if r := call("GET", "/"+session.ID, nil); r.StatusCode != 404 {
		t.Fatal("cross-account read", r)
	}
	if r := call("GET", "", nil); !strings.Contains(r.Body, `"sessions":[]`) {
		t.Fatal(r)
	}
	user = ""
	if r := call("GET", "", nil); r.StatusCode != 401 {
		t.Fatal("anonymous", r)
	}
	user = "alice"
	if r := call("POST", "/"+session.ID+"/photos", Photo{Mime: "image/svg+xml", Bytes: 20}); r.StatusCode != 400 {
		t.Fatal(r)
	}
	uploaded := call("POST", "/"+session.ID+"/photos", Photo{Mime: "image/jpeg", Bytes: 100})
	if uploaded.StatusCode != 201 {
		t.Fatal(uploaded)
	}
	var upload struct {
		Photo Photo `json:"photo"`
	}
	json.Unmarshal([]byte(uploaded.Body), &upload)
	path := "/" + session.ID + "/photos/" + upload.Photo.ID
	update := Photo{Revision: 1, State: "pending"}
	if r := call("PATCH", path, update); r.StatusCode != 409 {
		t.Fatal("unfinished upload accepted", r)
	}
	store.sizes[photoKey(user, session.ID, upload.Photo.ID, "original")] = 100
	store.sizes[photoKey(user, session.ID, upload.Photo.ID, "prepared.jpg")] = 40
	if r := call("PATCH", path, update); r.StatusCode != 200 {
		t.Fatal(r)
	}
	if r := call("PATCH", path, update); r.StatusCode != 200 || !strings.Contains(r.Body, `"conflict":true`) {
		t.Fatal("stale changes must require review", r)
	}
	user = "bob"
	for _, method := range []string{"PATCH", "DELETE"} {
		if r := call(method, path, update); r.StatusCode != 404 {
			t.Fatal("cross-account write", r)
		}
	}
	user = "alice"
	if r := call("GET", "/"+session.ID, nil); !strings.Contains(r.Body, "preparedUrl") {
		t.Fatal(r)
	}
	if r := call("DELETE", path, map[string]bool{"permanent": true}); r.StatusCode != 200 {
		t.Fatal(r)
	}
	if r := call("PATCH", path, update); r.StatusCode != 404 {
		t.Fatal("resurrected photo", r)
	}
}
func TestRejectInvalidAccountToken(t *testing.T) {
	if _, e := verifyAccountOwner(context.Background(), events.APIGatewayV2HTTPRequest{Headers: map[string]string{"authorization": "Bearer invalid"}}); e == nil {
		t.Fatal("invalid token accepted")
	}
}

type accountTransport func(*http.Request) (*http.Response, error)

func (f accountTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestAccountClaimsRequireCognitoValidation(t *testing.T) {
	t.Setenv("COGNITO_CLIENT_ID", "client")
	t.Setenv("COGNITO_POOL_ID", "pool")
	t.Setenv("AWS_REGION", "us-east-1")
	old := accountHTTP
	defer func() { accountHTTP = old }()
	status := 401
	calls := 0
	accountHTTP = &http.Client{Transport: accountTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("X-Amz-Target") != "AWSCognitoIdentityProviderService.GetUser" {
			t.Fatal("not validating token")
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"UserAttributes":[{"Name":"sub","Value":"verified-user"}]}`)), Header: http.Header{}}, nil
	})}
	claims := base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"https://cognito-idp.us-east-1.amazonaws.com/pool","client_id":"client","token_use":"access"}`))
	req := events.APIGatewayV2HTTPRequest{Headers: map[string]string{"authorization": "Bearer header." + claims + ".signature"}}
	if _, e := verifyAccountOwner(context.Background(), req); e == nil {
		t.Fatal("unverified claims accepted")
	}
	status = 200
	if owner, e := verifyAccountOwner(context.Background(), req); e != nil || owner != "verified-user" {
		t.Fatal(owner, e)
	}
	if calls != 2 {
		t.Fatal(calls)
	}
}

func (m *memoryRecords) PutPhoto(ctx context.Context, po, pk string, pr int, o, k string, data []byte, r, e int) error {
	if m.rev[po+"/"+pk] != pr {
		return errConflict
	}
	return m.Put(ctx, o, k, data, r, e)
}

func (m *memoryRecords) MarkShredded(ctx context.Context, o, k string, data []byte) error {
	if m.data[o+"/"+k] == nil {
		return nil
	}
	m.rev[o+"/"+k]++
	m.data[o+"/"+k] = data
	return nil
}
func (m *memoryRecords) TrashCandidates(ctx context.Context, now int64) ([]trashRecord, error) {
	out := []trashRecord{}
	for key, data := range m.data {
		var p Photo
		if json.Unmarshal(data, &p) != nil {
			continue
		}
		if p.State == "shredded" || (p.State == "trash" && p.ExpiresAt <= now) {
			parts := strings.SplitN(key, "/", 2)
			out = append(out, trashRecord{parts[0], parts[1], p})
		}
	}
	return out, nil
}

func (m *memoryRecords) ObjectSHA256(ctx context.Context, key string) (string, int64, error) {
	return string(m.data["SHA#"+key]), m.sizes[key], nil
}
