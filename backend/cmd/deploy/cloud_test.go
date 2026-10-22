package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGemmaAccessCheck(t *testing.T) {
	for _, code := range []int{200, 403, 404, 429} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "GET" || r.Header.Get("x-goog-api-key") != "secret" {
				t.Error("wrong credential check")
			}
			w.WriteHeader(code)
			if code == 200 {
				_, _ = w.Write([]byte(`{"supportedGenerationMethods":["generateContent"]}`))
			} else {
				_, _ = w.Write([]byte(`{"error":"secret"}`))
			}
		}))
		err := checkGemmaAccess(server.Client(), server.URL, "secret")
		server.Close()
		if (err == nil) != (code == 200) {
			t.Fatalf("status %d: %v", code, err)
		}
		if err != nil && strings.Contains(err.Error(), "secret") {
			t.Fatal("key leaked")
		}
	}
}
