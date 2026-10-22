package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	_ "image/jpeg"
	"io"
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

func apiJSON(code int, value any) events.APIGatewayV2HTTPResponse {
	body, _ := json.Marshal(value)
	return events.APIGatewayV2HTTPResponse{StatusCode: code, Headers: map[string]string{"content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff"}, Body: string(body)}
}
func cloudError(code int, message string) events.APIGatewayV2HTTPResponse {
	return apiJSON(code, map[string]string{"error": message})
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
	request, err := http.NewRequestWithContext(ctx, "POST", googleEndpoint, bytes.NewReader(data))
	if err != nil {
		return cloudError(500, "Could not prepare cloud request.")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-goog-api-key", key)
	response, err := googleClient.Do(request)
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
		return cloudError(502, "Google could not process this photo. Retry later or choose an on-device model.")
	}
	var result struct {
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
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil || len(result.Candidates) == 0 {
		return cloudError(502, "Google returned no usable answer. The image may have been blocked.")
	}
	candidate := result.Candidates[0]
	if candidate.FinishReason != "STOP" {
		return cloudError(502, "Google did not finish a usable answer. Retry or choose an on-device model.")
	}
	var answer strings.Builder
	for _, part := range candidate.Content.Parts {
		if !part.Thought {
			answer.WriteString(part.Text)
		}
	}
	text := strings.TrimSpace(answer.String())
	if text == "" {
		return cloudError(502, "Google returned an empty answer.")
	}
	return apiJSON(200, map[string]string{"text": text, "model": cloudModel, "precision": "Provider-managed (not disclosed)"})
}
