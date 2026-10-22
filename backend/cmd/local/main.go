// Local development launcher: the Google credential is passed only to the API.
package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"

	"golang.org/x/term"
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
		if strings.EqualFold(name, "GEMINI_API_KEY") || strings.EqualFold(name, "AWS_LAMBDA_RUNTIME_API") || strings.HasPrefix(strings.ToUpper(name), "VITE_") {
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
	fmt.Println("Little Lens — local development")
	key := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if key == "" {
		fmt.Println("Google API key: https://aistudio.google.com/apikey")
		fmt.Print("Google API key (hidden; Enter uses on-device models only): ")
		value, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return fmt.Errorf("run this launcher in an interactive terminal, or set GEMINI_API_KEY")
		}
		key = strings.TrimSpace(string(value))
	} else {
		fmt.Println("Using GEMINI_API_KEY from the environment.")
	}
	env := withoutSecrets(os.Environ())
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
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, "./cmd/api")
	build.Dir = filepath.Join(root, "backend")
	build.Env = env
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("API build failed: %w", err)
	}
	api := exec.CommandContext(ctx, binary)
	api.Env = append(env, "GEMINI_API_KEY="+key, "LISTEN_ADDR=127.0.0.1:8080", "SITE_ORIGIN=http://localhost:5173")
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
