package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	_ "image/jpeg"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aws/aws-lambda-go/events"
)

const cloudModel = "gemma-4-26b-a4b-it"
const maxCloudBody = 3 << 20

var googleClient = &http.Client{Timeout: 25 * time.Second}
var googleEndpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + cloudModel + ":generateContent"

// Retry only explicit transient HTTP failures, never quota or content-policy responses.
// The caller owns the shared deadline and closes the final response body.
func requestGoogle(ctx context.Context, client *http.Client, endpoint, key string, data []byte, backoff time.Duration) (*http.Response, error) {
	for attempt := 1; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("x-goog-api-key", key)
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		status := response.StatusCode
		transient := status == 500 || status == 502 || status == 503 || status == 504
		if !transient || attempt == 3 {
			return response, nil
		}
		response.Body.Close()
		entry, _ := json.Marshal(map[string]any{"event": "cloud-provider-retry", "providerStatus": status, "nextAttempt": attempt + 1})
		log.Print(string(entry))
		timer := time.NewTimer(backoff * time.Duration(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func apiJSON(code int, value any) events.APIGatewayV2HTTPResponse {
	body, _ := json.Marshal(value)
	return events.APIGatewayV2HTTPResponse{StatusCode: code, Headers: map[string]string{"content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff"}, Body: string(body)}
}
func cloudError(code int, message string) events.APIGatewayV2HTTPResponse {
	return apiJSON(code, map[string]string{"error": message})
}

// Restrict provider metadata to known enums; never copy arbitrary upstream strings.
func safeFinishReason(reason string) string {
	switch reason {
	case "", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "OTHER":
		return reason
	default:
		return "OTHER"
	}
}
func cloudFailure(code int, message, kind string, upstream int, reason string) events.APIGatewayV2HTTPResponse {
	details := map[string]any{"error": message, "code": kind, "providerStatus": upstream, "finishReason": safeFinishReason(reason)}
	entry, _ := json.Marshal(map[string]any{"event": "cloud-provider-error", "code": kind, "providerStatus": upstream, "finishReason": safeFinishReason(reason)})
	log.Print(string(entry))
	return apiJSON(code, details)
}
func cloudRoute(ctx context.Context, req events.APIGatewayV2HTTPRequest) events.APIGatewayV2HTTPResponse {
	method := req.RequestContext.HTTP.Method
	if req.RawPath == "/api/cloud" {
		if method != "GET" {
			return cloudError(405, "Use GET.")
		}
		return apiJSON(200, map[string]any{"enabled": os.Getenv("GEMINI_API_KEY") != "", "model": cloudModel})
	}
	if method != "POST" {
		return cloudError(405, "Use POST.")
	}
	key := os.Getenv("GEMINI_API_KEY")
	if key == "" {
		return cloudError(503, "Cloud Gemma is not configured. Run the deployment wizard to add its API key.")
	}
	// This origin check prevents browser cross-site uploads; it is not user authentication.
	if origin := req.Headers["origin"]; origin != "" && os.Getenv("SITE_ORIGIN") != "" && origin != os.Getenv("SITE_ORIGIN") {
		return cloudError(403, "Origin not allowed.")
	}
	if len(req.Body) > maxCloudBody {
		return cloudError(413, "Image request is too large.")
	}
	body := []byte(req.Body)
	if req.IsBase64Encoded {
		var err error
		body, err = base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			return cloudError(400, "Invalid request encoding.")
		}
	}
	var input struct {
		Image   string `json:"image"`
		Prompt  string `json:"prompt"`
		Consent bool   `json:"consent"`
	}
	if json.Unmarshal(body, &input) != nil || !input.Consent {
		return cloudError(400, "Confirm consent to send photos to Google.")
	}
	input.Prompt = strings.TrimSpace(input.Prompt)
	if input.Prompt == "" || utf8.RuneCountInString(input.Prompt) > 1000 {
		return cloudError(400, "Prompt must contain 1–1000 characters.")
	}
	const prefix = "data:image/jpeg;base64,"
	if !strings.HasPrefix(input.Image, prefix) {
		return cloudError(400, "Send a prepared JPEG image.")
	}
	encoded := strings.TrimPrefix(input.Image, prefix)
	photo, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return cloudError(400, "Invalid image encoding.")
	}
	dimensions, format, err := image.DecodeConfig(bytes.NewReader(photo))
	if err != nil || format != "jpeg" || dimensions.Width > 768 || dimensions.Height > 768 {
		return cloudError(400, "Send a JPEG no larger than 768 pixels per side.")
	}
	payload := map[string]any{
		"contents":         []any{map[string]any{"role": "user", "parts": []any{map[string]any{"inlineData": map[string]string{"mimeType": "image/jpeg", "data": encoded}}, map[string]string{"text": input.Prompt}}}},
		"generationConfig": map[string]any{"temperature": 0, "maxOutputTokens": 128, "thinkingConfig": map[string]string{"thinkingLevel": "minimal"}},
	}
	data, _ := json.Marshal(payload)
	// One deadline covers every attempt, backoff and response read.
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	response, err := requestGoogle(ctx, googleClient, googleEndpoint, key, data, 500*time.Millisecond)
	// Never return/log provider bodies, URLs with secrets, prompts or images.
	if err != nil {
		return cloudError(504, "Google did not respond in time. Retry this photo later.")
	}
	defer response.Body.Close()
	if response.StatusCode == 429 {
		return cloudError(429, "Google's free quota or rate limit was reached. Wait and retry; no paid fallback is used.")
	}
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return cloudError(503, "Google rejected the API key or model access. Update GEMINI_API_KEY and rerun deployment.")
	}
	if response.StatusCode == 404 {
		return cloudError(503, "Hosted Gemma is unavailable for this project. Check Google AI Studio model access.")
	}
	if response.StatusCode != 200 {
		return cloudFailure(502, "Google could not process this photo. Retry later or choose an on-device model.", "PROVIDER_HTTP_ERROR", response.StatusCode, "")
	}
	var result struct {
		PromptFeedback struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text    string `json:"text"`
					Thought bool   `json:"thought"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil {
		return cloudFailure(502, "Google returned an invalid response. Retry later.", "INVALID_PROVIDER_RESPONSE", response.StatusCode, "")
	}
	if result.PromptFeedback.BlockReason != "" {
		return cloudFailure(502, "Google blocked this request. Review this photo manually or use an on-device model.", "PROMPT_BLOCKED", response.StatusCode, result.PromptFeedback.BlockReason)
	}
	if len(result.Candidates) == 0 {
		return cloudFailure(502, "Google returned no candidate answer. Retry later or review manually.", "NO_CANDIDATES", response.StatusCode, "")
	}
	candidate := result.Candidates[0]
	if candidate.FinishReason != "STOP" {
		reason := safeFinishReason(candidate.FinishReason)
		if reason == "MAX_TOKENS" {
			return cloudFailure(502, "Gemma reached its output token limit before finishing. The partial answer was not accepted.", "OUTPUT_TRUNCATED", response.StatusCode, reason)
		}
		switch reason {
		case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY":
			return cloudFailure(502, "Google blocked the answer. Review this photo manually or use an on-device model.", "OUTPUT_BLOCKED", response.StatusCode, reason)
		}
		return cloudFailure(502, "Google did not finish its answer. Retry later or use an on-device model.", "INCOMPLETE_OUTPUT", response.StatusCode, reason)
	}
	var answer strings.Builder
	for _, part := range candidate.Content.Parts {
		if !part.Thought {
			answer.WriteString(part.Text)
		}
	}
	text := strings.TrimSpace(answer.String())
	if text == "" {
		return cloudFailure(502, "Google returned an empty answer.", "EMPTY_OUTPUT", response.StatusCode, candidate.FinishReason)
	}
	return apiJSON(200, map[string]string{"text": text, "model": cloudModel, "precision": "Provider-managed (not disclosed)"})
}
