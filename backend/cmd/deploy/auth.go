package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

func ssoExpired(message string) bool {
	text := strings.ToLower(message)
	for _, marker := range []string{"invalidgrantexception", "sso session associated with this profile has expired", "sso token has expired", "refresh cached sso token failed", "unable to refresh sso token", "token has expired and refresh failed", "error loading sso token"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

// Retry only authentication failures, once. Never retry a deployment mutation here.
func withSSOLogin(attempt func() ([]byte, error), login func() error) ([]byte, error) {
	data, err := attempt()
	if err == nil || !ssoExpired(string(data)) {
		return data, err
	}
	if err = login(); err != nil {
		return nil, err
	}
	return attempt()
}
func effectiveProfile(profile string) string {
	if profile != "auto" && profile != "" {
		return profile
	}
	for _, key := range []string{"AWS_PROFILE", "AWS_DEFAULT_PROFILE"} {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return "default"
}
func ssoLogin(dir, profile string) error {
	profile = effectiveProfile(profile)
	configured := false
	for _, key := range []string{"sso_session", "sso_start_url"} {
		data, err := command(dir, "aws", "configure", "get", key, "--profile", profile).Output()
		if err == nil && strings.TrimSpace(string(data)) != "" {
			configured = true
			break
		}
	}
	if !configured {
		return fmt.Errorf("AWS credentials expired, but profile %q is not configured for SSO; refresh its credentials and rerun", profile)
	}
	fmt.Printf("AWS SSO session needs renewal for profile %s. Complete the browser sign-in to continue.\n", profile)
	return run(dir, "aws", "sso", "login", "--profile", profile)
}
func awsIdentity(dir, profile string) ([]byte, error) {
	attempt := func() ([]byte, error) {
		return command(dir, "aws", "sts", "get-caller-identity", "--profile", effectiveProfile(profile), "--output", "json").CombinedOutput()
	}
	data, err := withSSOLogin(attempt, func() error { return ssoLogin(dir, profile) })
	if err != nil {
		return nil, fmt.Errorf("AWS authentication failed: %w\n%s", err, strings.TrimSpace(string(data)))
	}
	return data, nil
}
func loginStateBackend(dir, root, profile, backend, account string) error {
	attempt := func() ([]byte, error) {
		cmd := command(dir, "pulumi", "login", backend, "--non-interactive")
		var captured bytes.Buffer
		cmd.Stdin = os.Stdin
		cmd.Stdout = io.MultiWriter(os.Stdout, &captured)
		cmd.Stderr = cmd.Stdout
		err := cmd.Run()
		return captured.Bytes(), err
	}
	_, err := withSSOLogin(attempt, func() error {
		if err := ssoLogin(root, profile); err != nil {
			return err
		}
		data, err := command(root, "aws", "sts", "get-caller-identity", "--profile", effectiveProfile(profile), "--output", "json").CombinedOutput()
		if err != nil {
			return fmt.Errorf("could not verify AWS identity after SSO login: %w", err)
		}
		var identity struct{ Account string }
		if err = json.Unmarshal(data, &identity); err != nil {
			return err
		}
		if identity.Account != account {
			return fmt.Errorf("AWS account changed after SSO login; expected %s, received %s", account, identity.Account)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("Pulumi state login failed after authentication check: %w", err)
	}
	return nil
}
