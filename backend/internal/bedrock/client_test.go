package bedrock

import (
	"context"
	"errors"
	"github.com/aws/aws-sdk-go-v2/aws"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testClient(server *httptest.Server) *Client {
	return &Client{Region: "us-east-1", endpoint: server.URL, http: server.Client(), credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: "test-key", SecretAccessKey: "test-secret", SessionToken: "temporary-token"}, nil
	})}
}
func TestSignedRetryPolicy(t *testing.T) {
	for _, tc := range []struct {
		statuses []int
		calls    int
	}{{[]int{500, 200}, 2}, {[]int{500, 502, 504}, 3}, {[]int{429}, 1}, {[]int{403}, 1}, {[]int{404}, 1}, {[]int{200}, 1}} {
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			i := int(calls.Add(1)) - 1
			data, _ := io.ReadAll(r.Body)
			if string(data) != "same payload" || !strings.Contains(r.Header.Get("Authorization"), "/us-east-1/bedrock-mantle/aws4_request") || r.Header.Get("X-Amz-Security-Token") != "temporary-token" || r.Header.Get("x-goog-api-key") != "" {
				t.Error("invalid signing or payload")
			}
			w.WriteHeader(tc.statuses[i])
		}))
		client := testClient(server)
		response, err := client.Send(context.Background(), "POST", "/openai/v1/chat/completions", []byte("same payload"))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		server.Close()
		if int(calls.Load()) != tc.calls {
			t.Fatal(calls.Load())
		}
	}
}
func TestSharedDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer server.Close()
	client := testClient(server)
	client.backoff = time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := client.Send(ctx, "POST", "/openai/v1/chat/completions", nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
func TestModelDiscoveryRoute(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/models/"+Model {
			t.Error("wrong metadata route")
		}
		w.Write([]byte(`{"id":"google.gemma-4-e2b"}`))
	}))
	defer server.Close()
	if err := testClient(server).CheckModel(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func TestApprovedRegionAndNoRedirects(t *testing.T) {
	if _, err := New(context.Background(), "invalid.example/path"); err == nil {
		t.Fatal("invalid endpoint accepted")
	}
	client, err := New(context.Background(), "us-east-1")
	if err != nil {
		t.Fatal(err)
	}
	if client.endpoint != "https://bedrock-mantle.us-east-1.api.aws" || client.http.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("unsafe endpoint or redirects")
	}
}
