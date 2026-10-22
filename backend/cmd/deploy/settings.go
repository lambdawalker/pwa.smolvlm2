package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type settings struct {
	Profile     string `json:"profile"`
	Account     string `json:"account"`
	Region      string `json:"region"`
	Stack       string `json:"stack"`
	Domain      string `json:"domain"`
	StateBucket string `json:"stateBucket"`
	KMSKey      string `json:"kmsKey"`
}

func loadSettings(path string) (settings, error) {
	var s settings
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}
func saveSettings(path string, s settings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}
func choose(label, saved, fallback string, configure bool) (string, error) {
	if saved != "" && !configure {
		fmt.Printf("%s: %s (saved)\n", label, saved)
		return saved, nil
	}
	if saved != "" {
		fallback = saved
	}
	return ask(label, fallback)
}
func backendURL(s settings) string {
	q := url.Values{"region": {s.Region}, "awssdk": {"v2"}}
	if s.Profile != "auto" && s.Profile != "" {
		q.Set("profile", s.Profile)
	}
	return "s3://" + s.StateBucket + "/little-lens?" + q.Encode()
}
func secretsURL(s settings) string {
	q := url.Values{"region": {s.Region}, "awssdk": {"v2"}}
	return "awskms:///" + s.KMSKey + "?" + q.Encode()
}
func validBucket(name string) bool {
	if len(name) < 3 || len(name) > 63 || strings.Contains(name, ".") {
		return false
	}
	return labelPattern.MatchString(name)
}

// State storage deliberately lives outside the application stack: destroy must not
// delete its own state or the key required to decrypt its configuration.
func ensureState(root string, s *settings) error {
	args := []string{"s3api", "head-bucket", "--bucket", s.StateBucket, "--expected-bucket-owner", s.Account, "--region", s.Region}
	cmd := command(root, "aws", args...)
	if b, err := cmd.CombinedOutput(); err != nil {
		// Never interpret a forbidden bucket as missing, or modify a bucket in another account.
		if !strings.Contains(string(b), "404") && !strings.Contains(string(b), "Not Found") && !strings.Contains(string(b), "NoSuchBucket") {
			return fmt.Errorf("cannot access state bucket %s: %s", s.StateBucket, strings.TrimSpace(string(b)))
		}
		create := []string{"s3api", "create-bucket", "--bucket", s.StateBucket, "--region", s.Region}
		if s.Region != "us-east-1" {
			create = append(create, "--create-bucket-configuration", "LocationConstraint="+s.Region)
		}
		if err = run(root, "aws", create...); err != nil {
			return err
		}
	}
	for _, args := range [][]string{
		{"s3api", "put-public-access-block", "--bucket", s.StateBucket, "--public-access-block-configuration", "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"},
		{"s3api", "put-bucket-versioning", "--bucket", s.StateBucket, "--versioning-configuration", "Status=Enabled"},
		{"s3api", "put-bucket-encryption", "--bucket", s.StateBucket, "--server-side-encryption-configuration", `{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}`},
	} {
		args = append(args, "--expected-bucket-owner", s.Account, "--region", s.Region)
		if err := run(root, "aws", args...); err != nil {
			return err
		}
	}
	alias := "alias/little-lens-pulumi"
	if s.KMSKey != "" {
		alias = s.KMSKey
	}
	cmd = command(root, "aws", "kms", "describe-key", "--key-id", alias, "--region", s.Region, "--query", "KeyMetadata.Arn", "--output", "text")
	data, err := cmd.Output()
	if err != nil {
		if s.KMSKey != "" {
			return fmt.Errorf("saved KMS key unavailable; verify AWS permissions and key status")
		}
		if exit, ok := err.(*os.PathError); ok {
			return exit
		}
		// Distinguish NotFound from authorization/network errors before creating a key.
		check := command(root, "aws", "kms", "describe-key", "--key-id", alias, "--region", s.Region)
		details, _ := check.CombinedOutput()
		if !strings.Contains(string(details), "NotFoundException") {
			return fmt.Errorf("cannot access state KMS key: %s", details)
		}
		data, err = output(root, "aws", "kms", "create-key", "--description", "Audit Pulumi secrets", "--region", s.Region, "--query", "KeyMetadata.Arn", "--output", "text")
		if err != nil {
			return err
		}
		s.KMSKey = strings.TrimSpace(string(data))
		if err = run(root, "aws", "kms", "create-alias", "--alias-name", alias, "--target-key-id", s.KMSKey, "--region", s.Region); err != nil {
			return err
		}
	} else {
		s.KMSKey = strings.TrimSpace(string(data))
	}
	return run(root, "aws", "kms", "enable-key-rotation", "--key-id", s.KMSKey, "--region", s.Region)
}
func setSecret(dir, key, value string) error {
	cmd := command(dir, "pulumi", "config", "set", key, "--secret")
	cmd.Stdin = strings.NewReader(value + "\n")
	// Do not echo CLI output from a command carrying a secret on stdin.
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("could not save encrypted %s: %w", key, err)
	}
	return nil
}
