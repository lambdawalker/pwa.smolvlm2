package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// No photo uploads or inference endpoints: inference remains in the browser.
func handle(_ context.Context, req events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
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
			response.Body = `{"status":"ok","service":"little-lens","inference":"on-device"}`
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
	server := &http.Server{Addr: addr, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := events.APIGatewayV2HTTPRequest{RawPath: r.URL.Path}
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
