package main

import (
	"context"
	"github.com/aws/aws-lambda-go/events"
	"testing"
)

func TestRoutes(t *testing.T) {
	for _, tc := range []struct {
		path, method string
		code         int
	}{{"/api/health", "GET", 200}, {"/api/health", "HEAD", 200}, {"/api/health", "POST", 405}, {"/api/unknown", "GET", 404}} {
		req := events.APIGatewayV2HTTPRequest{RawPath: tc.path}
		req.RequestContext.HTTP.Method = tc.method
		got, err := handle(context.Background(), req)
		if err != nil || got.StatusCode != tc.code {
			t.Fatalf("%s %s: %+v %v", tc.method, tc.path, got, err)
		}
		if got.Headers["cache-control"] != "no-store" {
			t.Fatal("API must not be cached")
		}
		if tc.method == "HEAD" && got.Body != "" {
			t.Fatal("HEAD must have no body")
		}
	}
}
