package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// Local inference stays in the browser; cloud requests are explicitly selected.
func handle(ctx context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	if req.RawPath == "/api/auth-config" {
		if req.RequestContext.HTTP.Method != "GET" {
			return cloudError(405, "Use GET."), nil
		}
		return accountConfig(), nil
	}
	if req.RawPath == "/api/sessions" || strings.HasPrefix(req.RawPath, "/api/sessions/") {
		return sessionRoute(ctx, req), nil
	}
	if req.RawPath == "/api/classify" && accountsEnabled() {
		if _, e := accountOwner(ctx, req); e != nil {
			return cloudError(401, "Sign in to classify photos."), nil
		}
	}
	if req.RawPath == "/api/cloud" || req.RawPath == "/api/classify" {
		return cloudRoute(ctx, req), nil
	}
	response := events.APIGatewayV2HTTPResponse{StatusCode: 404, Headers: map[string]string{
		"content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
	}, Body: `{"error":"not found"}`}
	if req.RawPath == "/api/health" {
		if req.RequestContext.HTTP.Method != "GET" && req.RequestContext.HTTP.Method != "HEAD" {
			response.StatusCode = 405
			response.Headers["allow"] = "GET, HEAD"
			response.Body = `{"error":"method not allowed"}`
		} else {
			response.StatusCode = 200
			response.Body = `{"status":"ok","service":"little-lens","inference":"on-device-and-optional-cloud"}`
		}
	}
	if req.RequestContext.HTTP.Method == "HEAD" {
		response.Body = ""
	}
	return response, nil
}

func main() {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
		lambda.Start(handle)
		return
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	server := &http.Server{Addr: addr, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, maxCloudBody+1))
		if err != nil || len(body) > maxCloudBody {
			http.Error(w, "Request too large", 413)
			return
		}
		req := events.APIGatewayV2HTTPRequest{RawPath: r.URL.Path, Body: string(body), Headers: map[string]string{"origin": r.Header.Get("Origin"), "authorization": r.Header.Get("Authorization")}}
		req.RequestContext.HTTP.Method = r.Method
		response, _ := handle(r.Context(), req)
		for key, value := range response.Headers {
			w.Header().Set(key, value)
		}
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write([]byte(response.Body))
	})}
	log.Printf("API listening on http://%s", addr)
	log.Fatal(server.ListenAndServe())
}
