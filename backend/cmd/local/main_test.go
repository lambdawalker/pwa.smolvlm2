package main

import (
	"reflect"
	"testing"
)

func TestFrontendEnvironmentExcludesCredentials(t *testing.T) {
	got := withoutSecrets([]string{"PATH=/bin", "GEMINI_API_KEY=secret", "gemini_api_key=secret", "VITE_KEY=secret", "AWS_LAMBDA_RUNTIME_API=host", "OTHER=value"})
	if !reflect.DeepEqual(got, []string{"PATH=/bin", "OTHER=value"}) {
		t.Fatal("unsafe environment", got)
	}
}
