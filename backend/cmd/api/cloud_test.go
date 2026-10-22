package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func cloudRequest(consent bool) events.APIGatewayV2HTTPRequest {
	var imageBytes bytes.Buffer
	_ = jpeg.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 10, 10)), nil)
	body, _ := json.Marshal(map[string]any{"image": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(imageBytes.Bytes()), "prompt": "Classify this photo.", "consent": consent})
	req := events.APIGatewayV2HTTPRequest{RawPath: "/api/classify", Body: string(body)}
	req.RequestContext.HTTP.Method = "POST"
	return req
}
func TestCloudValidationAndDisabled(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "")
	req := cloudRequest(true)
	got := cloudRoute(context.Background(), req)
	if got.StatusCode != 503 {
		t.Fatal(got)
	}
	t.Setenv("GEMINI_API_KEY", "private-key")
	req = cloudRequest(false)
	if cloudRoute(context.Background(), req).StatusCode != 400 {
		t.Fatal("consent required")
	}
	req = cloudRequest(true)
	req.Body = strings.Repeat("x", maxCloudBody+1)
	if cloudRoute(context.Background(), req).StatusCode != 413 {
		t.Fatal("limit required")
	}
	req = cloudRequest(true)
	req.Body = `{"image":"https://example.com/a.jpg","prompt":"test","consent":true}`
	if cloudRoute(context.Background(), req).StatusCode != 400 {
		t.Fatal("remote URL must not be fetched")
	}
	t.Setenv("SITE_ORIGIN", "https://audit.apexfission.com")
	req = cloudRequest(true)
	req.Headers = map[string]string{"origin": "https://other.test"}
	if cloudRoute(context.Background(), req).StatusCode != 403 {
		t.Fatal("origin")
	}
}
func TestCloudProviderResponses(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "private-key")
	for _, tc := range []struct {
		status int
		body   string
		want   int
	}{
		{200, `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"thought":true,"text":"internal"},{"text":"Documents"}]}}]}`, 200},
		{429, `{"error":"private-key"}`, 429}, {403, `{"error":"private-key"}`, 503}, {500, `{"error":"private-key"}`, 502},
		{200, `{"candidates":[]}`, 502}, {200, `{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"Documents"}]}}]}`, 502},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("x-goog-api-key") != "private-key" {
				t.Error("missing key")
			}
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid provider JSON")
			}
			if len(body["contents"].([]any)) != 1 {
				t.Error("missing image/prompt")
			}
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		original := googleEndpoint
		googleEndpoint = server.URL
		got := cloudRoute(context.Background(), cloudRequest(true))
		googleEndpoint = original
		server.Close()
		if got.StatusCode != tc.want || strings.Contains(got.Body, "private-key") || strings.Contains(got.Body, "internal") {
			t.Fatalf("unsafe/incorrect response: %+v", got)
		}
		if tc.want == 200 && !strings.Contains(got.Body, "Documents") {
			t.Fatal(got)
		}
	}
}

func TestCloudFailureDiagnostics(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "private-key")
	for _, tc := range []struct {
		status             int
		body, code, reason string
	}{
		{200, `{"candidates":[{"finishReason":"MAX_TOKENS"}]}`, "OUTPUT_TRUNCATED", "MAX_TOKENS"},
		{200, `{"candidates":[{"finishReason":"SAFETY"}]}`, "OUTPUT_BLOCKED", "SAFETY"},
		{200, `{"promptFeedback":{"blockReason":"SAFETY"}}`, "PROMPT_BLOCKED", "SAFETY"},
		{200, `{"candidates":[]}`, "NO_CANDIDATES", ""},
		{200, `not json`, "INVALID_PROVIDER_RESPONSE", ""},
		{503, `{"error":"private-key"}`, "PROVIDER_HTTP_ERROR", ""},
		{200, `{"candidates":[{"finishReason":"private-key"}]}`, "INCOMPLETE_OUTPUT", "OTHER"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		previous := googleEndpoint
		googleEndpoint = server.URL
		got := cloudRoute(context.Background(), cloudRequest(true))
		googleEndpoint = previous
		server.Close()
		var response struct {
			Code, FinishReason string
			ProviderStatus     int
		}
		if json.Unmarshal([]byte(got.Body), &response) != nil || response.Code != tc.code || response.FinishReason != tc.reason || response.ProviderStatus != tc.status {
			t.Fatalf("unexpected diagnostics: %s", got.Body)
		}
		if strings.Contains(got.Body, "private-key") {
			t.Fatal("unsafe diagnostic")
		}
	}
}
