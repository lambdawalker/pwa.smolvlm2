package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestGoogleRetryPolicy(t *testing.T) {
	for _, tc := range []struct {
		name     string
		statuses []int
		calls    int
	}{
		{"recovers", []int{500, 200}, 2},
		{"bounded", []int{500, 500, 500}, 3},
		{"gateway failures", []int{502, 503, 504}, 3},
		{"quota", []int{429}, 1},
		{"credentials", []int{403}, 1},
		{"missing", []int{404}, 1},
		{"successful HTTP including blocked content", []int{200}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := int(calls.Add(1)) - 1
				body, _ := io.ReadAll(r.Body)
				if string(body) != "same payload" || r.Header.Get("x-goog-api-key") != "test-key" || r.Method != "POST" {
					t.Error("retry changed request")
				}
				if n >= len(tc.statuses) {
					t.Error("too many attempts")
					w.WriteHeader(500)
					return
				}
				w.WriteHeader(tc.statuses[n])
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			response, err := requestGoogle(ctx, server.Client(), server.URL, "test-key", []byte("same payload"), 0)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if int(calls.Load()) != tc.calls || response.StatusCode != tc.statuses[tc.calls-1] {
				t.Fatalf("calls=%d status=%d", calls.Load(), response.StatusCode)
			}
		})
	}
}

func TestGoogleRetrySharedDeadline(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := requestGoogle(ctx, server.Client(), server.URL, "test-key", nil, time.Second)
	if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
}
