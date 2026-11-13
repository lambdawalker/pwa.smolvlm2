package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

func deploymentLabel(s settings) string {
	domain := s.Domain
	if domain == "" {
		domain = "audit.apexfission.com"
	}
	return domain + " | pwa.smolvlm2"
}
func deploymentTags(s settings) map[string]string {
	domain := s.Domain
	if domain == "" {
		domain = "audit.apexfission.com"
	}
	return map[string]string{"Project": "Audit", "Repository": "https://github.com/lambdawalker/pwa.smolvlm2", "Domain": domain, "Stack": s.Stack, "ManagedBy": "Audit deployment wizard"}
}

type bucketTag struct {
	Key   string `json:"Key"`
	Value string `json:"Value"`
}

func mergeBucketTags(existing []bucketTag, metadata map[string]string) []bucketTag {
	values := map[string]string{}
	for _, t := range existing {
		values[t.Key] = t.Value
	}
	for k, v := range metadata {
		values[k] = v
	}
	result := []bucketTag{}
	for k, v := range values {
		result = append(result, bucketTag{k, v})
	}
	return result
}
func stateBucketTagReadArgs(s settings) []string {
	return []string{"s3api", "get-bucket-tagging", "--bucket", s.StateBucket, "--expected-bucket-owner", s.Account, "--region", s.Region, "--output", "json", "--no-cli-pager"}
}
func readStateBucketTags(cmd *exec.Cmd) ([]bucketTag, error) {
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		if strings.Contains(stderr.String(), "(NoSuchTagSet)") {
			return nil, nil
		}
		return nil, fmt.Errorf("read state bucket tags: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	var existing struct {
		TagSet []bucketTag `json:"TagSet"`
	}
	if err = json.Unmarshal(data, &existing); err != nil {
		return nil, fmt.Errorf("decode AWS state bucket tags (expected JSON): %w", err)
	}
	return existing.TagSet, nil
}
func tagStateBucket(root string, s settings) error {
	tags, err := readStateBucketTags(command(root, "aws", stateBucketTagReadArgs(s)...))
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(struct {
		TagSet []bucketTag `json:"TagSet"`
	}{mergeBucketTags(tags, deploymentTags(s))})
	return run(root, "aws", "s3api", "put-bucket-tagging", "--bucket", s.StateBucket, "--expected-bucket-owner", s.Account, "--region", s.Region, "--tagging", string(payload))
}
