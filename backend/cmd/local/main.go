// Local development launcher: AWS credentials are passed only to the Go API.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/lambdawalker/pwa.smolvlm2/backend/internal/bedrock"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Local startup stopped:", err)
		os.Exit(1)
	}
}
func withoutSecrets(env []string) []string {
	out := []string{}
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "GEMINI_API_KEY") || strings.EqualFold(name, "OPENAI_API_KEY") || strings.EqualFold(name, "HF_TOKEN") || strings.HasPrefix(strings.ToUpper(name), "AWS_") || strings.HasPrefix(strings.ToUpper(name), "BEDROCK_") || strings.HasPrefix(strings.ToUpper(name), "VITE_") {
			continue
		}
		out = append(out, entry)
	}
	return out
}
func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	root, err := filepath.Abs("..")
	if err != nil {
		return err
	}
	for _, tool := range []string{"node", "npm", "go"} {
		if _, err := exec.LookPath(tool); err != nil {
			return fmt.Errorf("%s is required; install it and restart your terminal", tool)
		}
	}
	for _, addr := range []string{"127.0.0.1:8080", "127.0.0.1:5173"} {
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			return fmt.Errorf("port %s is already in use; stop the other server first", addr)
		}
		listener.Close()
	}
	fmt.Println("Audit — local development")
	var saved struct {
		Profile string `json:"profile"`
		Region  string `json:"region"`
	}
	if data, err := os.ReadFile(filepath.Join(root, ".deploy", "settings.json")); err == nil {
		json.Unmarshal(data, &saved)
	}
	profile := os.Getenv("AWS_PROFILE")
	if profile == "" && saved.Profile != "" && saved.Profile != "auto" {
		profile = saved.Profile
		os.Setenv("AWS_PROFILE", profile)
	}
	region := os.Getenv("BEDROCK_REGION")
	if region == "" {
		region = saved.Region
	}
	if region == "" {
		region = "us-east-1"
	}
	checkCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	client, err := bedrock.New(checkCtx, region)
	if err != nil {
		return err
	}
	if err = client.CheckModel(checkCtx); err != nil {
		return fmt.Errorf("AWS Gemma access is not ready: %w; sign in with aws sso login --profile YOUR_PROFILE and verify Bedrock permissions", err)
	}
	fmt.Printf("Amazon Bedrock • %s • %s. No Google API key is used.\n", bedrock.Model, region)
	env := withoutSecrets(os.Environ())
	backendEnv := []string{}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(name)
		if upper == "GEMINI_API_KEY" || upper == "OPENAI_API_KEY" || upper == "HF_TOKEN" || upper == "AWS_LAMBDA_RUNTIME_API" || strings.HasPrefix(upper, "VITE_") {
			continue
		}
		backendEnv = append(backendEnv, entry)
	}
	// npm.cmd must be launched through cmd.exe on Windows.
	npm := exec.CommandContext(ctx, "npm", "ci")
	if runtime.GOOS == "windows" {
		npm = exec.CommandContext(ctx, "cmd.exe", "/d", "/c", "npm ci")
	}
	npm.Dir = root
	npm.Env = env
	npm.Stdout = os.Stdout
	npm.Stderr = os.Stderr
	fmt.Println("Installing dependencies…")
	if err := npm.Run(); err != nil {
		return fmt.Errorf("npm ci failed: %w", err)
	}
	assets := exec.CommandContext(ctx, "node", "scripts/assets.mjs")
	assets.Dir = root
	assets.Env = env
	assets.Stdout = os.Stdout
	assets.Stderr = os.Stderr
	if err := assets.Run(); err != nil {
		return fmt.Errorf("preparing browser assets failed: %w", err)
	}
	temp, err := os.MkdirTemp("", "little-lens-local-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	binary := filepath.Join(temp, "api")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.CommandContext(ctx, "go", "build", "-buildvcs=false", "-o", binary, "./cmd/api")
	build.Dir = filepath.Join(root, "backend")
	build.Env = env
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("API build failed: %w", err)
	}
	api := exec.CommandContext(ctx, binary)
	api.Env = append(backendEnv, "BEDROCK_ENABLED=true", "BEDROCK_REGION="+region, "LISTEN_ADDR=127.0.0.1:8080", "SITE_ORIGIN=http://localhost:5173")
	api.Stdout = os.Stdout
	api.Stderr = os.Stderr
	vite := exec.CommandContext(ctx, "node", filepath.Join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", "5173", "--strictPort")
	vite.Dir = root
	vite.Env = env
	vite.Stdout = os.Stdout
	vite.Stderr = os.Stderr
	if err := api.Start(); err != nil {
		return fmt.Errorf("API startup failed: %w", err)
	}
	if err := vite.Start(); err != nil {
		api.Process.Kill()
		api.Wait()
		return fmt.Errorf("frontend startup failed: %w", err)
	}
	fmt.Println("Open http://localhost:5173 — press Ctrl+C to stop both servers.")
	results := make(chan error, 2)
	go func() { results <- api.Wait() }()
	go func() { results <- vite.Wait() }()
	select {
	case <-ctx.Done():
		api.Process.Kill()
		vite.Process.Kill()
		<-results
		<-results
		return nil
	case err := <-results:
		api.Process.Kill()
		vite.Process.Kill()
		<-results
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("a local server stopped: %v", err)
	}
}
