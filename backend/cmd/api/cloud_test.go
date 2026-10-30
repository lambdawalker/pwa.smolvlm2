package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/aws/aws-lambda-go/events"
	"github.com/lambdawalker/pwa.smolvlm2/backend/internal/bedrock"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"strings"
	"testing"
)

func cloudRequest(consent bool) events.APIGatewayV2HTTPRequest {
	var photo bytes.Buffer
	jpeg.Encode(&photo, image.NewRGBA(image.Rect(0, 0, 10, 10)), nil)
	body, _ := json.Marshal(map[string]any{"image": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(photo.Bytes()), "prompt": "Classify this photo.", "consent": consent})
	req := events.APIGatewayV2HTTPRequest{RawPath: "/api/classify", Body: string(body)}
	req.RequestContext.HTTP.Method = "POST"
	return req
}
func TestCloudValidationAndDisabled(t *testing.T) {
	t.Setenv("BEDROCK_ENABLED", "false")
	if r := cloudRoute(context.Background(), cloudRequest(true)); r.StatusCode != 503 {
		t.Fatal(r)
	}
	t.Setenv("BEDROCK_ENABLED", "true")
	if r := cloudRoute(context.Background(), cloudRequest(false)); r.StatusCode != 400 {
		t.Fatal(r)
	}
	req := cloudRequest(true)
	req.Body = strings.Repeat("x", maxCloudBody+1)
	if r := cloudRoute(context.Background(), req); r.StatusCode != 413 {
		t.Fatal(r)
	}
	req.Body = `{"image":"https://example.com/a.jpg","prompt":"test","consent":true}`
	if r := cloudRoute(context.Background(), req); r.StatusCode != 400 {
		t.Fatal("remote image URL accepted", r)
	}
	t.Setenv("SITE_ORIGIN", "https://audit.apexfission.com")
	req = cloudRequest(true)
	req.Headers = map[string]string{"origin": "https://other.test"}
	if r := cloudRoute(context.Background(), req); r.StatusCode != 403 {
		t.Fatal(r)
	}
}
func TestBedrockResponsesAndPrivacy(t *testing.T) {
	t.Setenv("BEDROCK_ENABLED", "true")
	t.Setenv("BEDROCK_REGION", "us-east-1")
	old := invokeBedrock
	defer func() { invokeBedrock = old }()
	for _, tc := range []struct {
		status int
		body   string
		want   int
		code   string
	}{
		{200, `{"choices":[{"finish_reason":"stop","message":{"content":"Documents","reasoning_content":"internal-secret"}}]}`, 200, ""}, {403, `{"error":"private-secret"}`, 503, "PROVIDER_ACCESS_DENIED"}, {429, `{}`, 429, "PROVIDER_RATE_LIMIT"}, {500, `{}`, 502, "PROVIDER_HTTP_ERROR"}, {404, `{}`, 503, "MODEL_UNAVAILABLE"}, {200, `{"choices":[]}`, 502, "NO_CANDIDATES"}, {200, `bad json`, 502, "INVALID_PROVIDER_RESPONSE"}, {200, `{"choices":[{"finish_reason":"length"}]}`, 502, "OUTPUT_TRUNCATED"}, {200, `{"choices":[{"finish_reason":"stop","message":{"refusal":"private-secret"}}]}`, 502, "OUTPUT_BLOCKED"}, {200, `{"choices":[{"finish_reason":"tool_calls"}]}`, 502, "INCOMPLETE_OUTPUT"}, {200, `{"choices":[{"finish_reason":"stop","message":{"content":" "}}]}`, 502, "EMPTY_OUTPUT"},
	} {
		invokeBedrock = func(ctx context.Context, region string, data []byte) (*http.Response, error) {
			if region != "us-east-1" {
				t.Fatal(region)
			}
			var body map[string]any
			if json.Unmarshal(data, &body) != nil || body["model"] != bedrock.Model {
				t.Fatal("wrong payload")
			}
			content := body["messages"].([]any)[0].(map[string]any)["content"].([]any)
			if len(content) != 2 || content[0].(map[string]any)["type"] != "image_url" || body["reasoning_effort"] != "high" {
				t.Fatal("wrong multimodal request")
			}
			return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
		}
		result := cloudRoute(context.Background(), cloudRequest(true))
		if result.StatusCode != tc.want || strings.Contains(result.Body, "private-secret") || strings.Contains(result.Body, "internal-secret") {
			t.Fatal(result)
		}
		if tc.code != "" && !strings.Contains(result.Body, tc.code) {
			t.Fatal(result)
		}
	}
}
func TestCloudCredentialErrors(t *testing.T) {
	t.Setenv("BEDROCK_ENABLED", "true")
	old := invokeBedrock
	defer func() { invokeBedrock = old }()
	invokeBedrock = func(context.Context, string, []byte) (*http.Response, error) { return nil, bedrock.ErrCredentials }
	if r := cloudRoute(context.Background(), cloudRequest(true)); r.StatusCode != 503 {
		t.Fatal(r)
	}
}
