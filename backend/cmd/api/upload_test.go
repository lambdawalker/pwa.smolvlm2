package main

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

func TestPhotoUploadURLDoesNotSignEmptyBodyChecksum(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("PHOTOS_BUCKET", "audit-test")
	store, err := storeFactory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	signed, err := store.URL(context.Background(), "PUT", "users/test/original", "image/jpeg")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	for key := range parsed.Query() {
		if strings.Contains(strings.ToLower(key), "checksum") {
			t.Fatalf("browser uploads must not use a checksum computed for an empty body: %s", key)
		}
	}
	if parsed.Query().Get("X-Amz-Signature") == "" {
		t.Fatal("unsigned upload URL")
	}
}
