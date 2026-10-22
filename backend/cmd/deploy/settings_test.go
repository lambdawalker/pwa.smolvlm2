package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSavedValuesAvoidPrompts(t *testing.T) {
	old := input
	defer func() { input = old }()
	input = bufio.NewReader(strings.NewReader(""))
	got, err := choose("Region", "us-west-2", "us-east-1", false)
	if err != nil || got != "us-west-2" {
		t.Fatalf("saved value should not read stdin: %q %v", got, err)
	}
	input = bufio.NewReader(strings.NewReader("\n"))
	got, err = choose("Region", "", "us-east-1", false)
	if err != nil || got != "us-east-1" {
		t.Fatal("first setup must accept default")
	}
	input = bufio.NewReader(strings.NewReader("eu-west-1\n"))
	got, err = choose("Region", "us-east-1", "us-east-1", true)
	if err != nil || got != "eu-west-1" {
		t.Fatal("configure must allow editing")
	}
}
func TestSettingsPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".deploy", "settings.json")
	original := settings{Profile: "auto", Account: "123456789012", Region: "us-east-1", Stack: "dev", Domain: "audit.apexfission.com", StateBucket: "little-lens-state-123456789012-us-east-1", KMSKey: "arn:aws:kms:us-east-1:123456789012:key/example"}
	if err := saveSettings(path, original); err != nil {
		t.Fatal(err)
	}
	got, err := loadSettings(path)
	if err != nil || got != original {
		t.Fatalf("round trip: %+v %v", got, err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "token") {
		t.Fatal("settings must not store tokens")
	}
	if err = os.WriteFile(path, []byte("invalid json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = loadSettings(path); err == nil {
		t.Fatal("corrupt settings must not reset to a fresh deployment")
	}
}
func TestStateURLs(t *testing.T) {
	s := settings{StateBucket: "state-123", Region: "us-east-1", Profile: "team dev", KMSKey: "arn:aws:kms:us-east-1:123:key/id"}
	if got := backendURL(s); got != "s3://state-123/little-lens?awssdk=v2&profile=team+dev&region=us-east-1" {
		t.Fatal(got)
	}
	s.Profile = "auto"
	if strings.Contains(backendURL(s), "profile=") {
		t.Fatal("auto must use credential chain")
	}
	if strings.Contains(secretsURL(s), "profile=") {
		t.Fatal("KMS must follow current AWS credentials")
	}
	for _, name := range []string{"ABC", "ab", "a..b", "-bad", "bad-", "bucket/name"} {
		if validBucket(name) {
			t.Fatal(name)
		}
	}
}
