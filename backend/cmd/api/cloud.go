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
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"errors"
	"github.com/aws/aws-lambda-go/events"
	"github.com/lambdawalker/pwa.smolvlm2/backend/internal/bedrock"
)

const cloudModel = bedrock.Model
const maxCloudBody = 3 << 20

var invokeBedrock = bedrock.Invoke

func bedrockRegion() string {
	if region := os.Getenv("BEDROCK_REGION"); region != "" {
		return region
	}
	if region := os.Getenv("AWS_REGION"); region != "" {
		return region
	}
	return "us-east-1"
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
		return apiJSON(200, map[string]any{"enabled": os.Getenv("BEDROCK_ENABLED") == "true" && bedrock.ValidRegion(bedrockRegion()), "model": cloudModel})
	}
	if method != "POST" {
		return cloudError(405, "Use POST.")
	}
	if os.Getenv("BEDROCK_ENABLED") != "true" || !bedrock.ValidRegion(bedrockRegion()) {
		return cloudError(503, "AWS Gemma is not configured. Run the deployment wizard to enable Amazon Bedrock.")
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
		return cloudError(400, "Confirm consent to process photos with AWS.")
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

	payload := map[string]any{"model": cloudModel, "messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image_url", "image_url": map[string]string{"url": input.Image}}, map[string]string{"type": "text", "text": input.Prompt}}}}, "temperature": 0, "max_completion_tokens": 1024, "reasoning_effort": "high", "stream": false}
	data, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	response, err := invokeBedrock(ctx, bedrockRegion(), data)
	if err != nil {
		if errors.Is(err, bedrock.ErrCredentials) {
			return cloudError(503, "AWS inference credentials are unavailable. Check the Lambda role or sign in to AWS for local development.")
		}
		return cloudError(504, "AWS Gemma did not respond in time. Retry this photo later.")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 429:
		return cloudFailure(429, "AWS Gemma is rate limited. Wait and retry.", "PROVIDER_RATE_LIMIT", 429, "")
	case 401, 403:
		return cloudFailure(503, "AWS rejected model access. Check the Lambda Bedrock permission and account model access.", "PROVIDER_ACCESS_DENIED", response.StatusCode, "")
	case 404:
		return cloudFailure(503, "Gemma 4 E2B is unavailable in the configured AWS region.", "MODEL_UNAVAILABLE", 404, "")
	}
	if response.StatusCode != 200 {
		return cloudFailure(502, "AWS Gemma could not process this photo. Retry later.", "PROVIDER_HTTP_ERROR", response.StatusCode, "")
	}
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
				Refusal string `json:"refusal"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil {
		return cloudFailure(502, "AWS Gemma returned an invalid response.", "INVALID_PROVIDER_RESPONSE", 200, "")
	}
	if len(result.Choices) != 1 {
		return cloudFailure(502, "AWS Gemma returned no single answer.", "NO_CANDIDATES", 200, "")
	}
	choice := result.Choices[0]
	if choice.Message.Refusal != "" || choice.FinishReason == "content_filter" {
		return cloudFailure(502, "AWS Gemma declined this photo. Review it manually.", "OUTPUT_BLOCKED", 200, "SAFETY")
	}
	if choice.FinishReason == "length" {
		return cloudFailure(502, "Gemma reached the output limit. Review or retry this photo.", "OUTPUT_TRUNCATED", 200, "MAX_TOKENS")
	}
	if choice.FinishReason != "stop" {
		return cloudFailure(502, "AWS Gemma did not finish its answer.", "INCOMPLETE_OUTPUT", 200, "OTHER")
	}
	text := strings.TrimSpace(choice.Message.Content)
	if text == "" {
		return cloudFailure(502, "AWS Gemma returned an empty answer.", "EMPTY_OUTPUT", 200, "STOP")
	}
	return apiJSON(200, map[string]string{"text": text, "model": cloudModel, "precision": "AWS-managed (not disclosed)", "provider": "Amazon Bedrock"})
}
