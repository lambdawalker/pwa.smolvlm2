package main

import (
	"errors"
	"testing"
)

func TestSSORetry(t *testing.T) {
	for _, tc := range []struct {
		name, text       string
		failLogin        bool
		attempts, logins int
	}{
		{"expired", "refresh cached SSO token failed: InvalidGrantException", false, 2, 1},
		{"denied", "AccessDenied: not authorized for s3:GetObject", false, 1, 0},
		{"network", "connection timed out", false, 1, 0},
		{"cancelled", "SSO token has expired", true, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			attempts, logins := 0, 0
			_, err := withSSOLogin(func() ([]byte, error) { attempts++; return []byte(tc.text), errors.New("failed") }, func() error {
				logins++
				if tc.failLogin {
					return errors.New("cancelled")
				}
				return nil
			})
			if err == nil || attempts != tc.attempts || logins != tc.logins {
				t.Fatalf("attempts=%d logins=%d err=%v", attempts, logins, err)
			}
		})
	}
}
func TestSSOSuccessAndRecovery(t *testing.T) {
	attempts, logins := 0, 0
	data, err := withSSOLogin(func() ([]byte, error) {
		attempts++
		if attempts == 1 {
			return []byte("Error loading SSO Token: Token does not exist"), errors.New("expired")
		}
		return []byte("identity"), nil
	}, func() error { logins++; return nil })
	if err != nil || string(data) != "identity" || attempts != 2 || logins != 1 {
		t.Fatal("did not recover", err)
	}
	_, err = withSSOLogin(func() ([]byte, error) { return []byte("ok"), nil }, func() error { t.Fatal("unexpected login"); return nil })
	if err != nil {
		t.Fatal(err)
	}
}
func TestEffectiveProfile(t *testing.T) {
	t.Setenv("AWS_PROFILE", "attestra")
	if effectiveProfile("auto") != "attestra" || effectiveProfile("other") != "other" {
		t.Fatal("wrong profile")
	}
}
