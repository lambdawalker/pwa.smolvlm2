package main

import (
	"encoding/json"
	"fmt"
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
func tagStateBucket(root string, s settings) error {
	var existing struct {
		TagSet []bucketTag `json:"TagSet"`
	}
	cmd := command(root, "aws", "s3api", "get-bucket-tagging", "--bucket", s.StateBucket, "--expected-bucket-owner", s.Account, "--region", s.Region)
	data, err := cmd.CombinedOutput()
	if err != nil {
		if !strings.Contains(string(data), "NoSuchTagSet") {
			return fmt.Errorf("read state bucket tags: %s", strings.TrimSpace(string(data)))
		}
	} else if err = json.Unmarshal(data, &existing); err != nil {
		return err
	}
	existing.TagSet = mergeBucketTags(existing.TagSet, deploymentTags(s))
	payload, _ := json.Marshal(existing)
	return run(root, "aws", "s3api", "put-bucket-tagging", "--bucket", s.StateBucket, "--expected-bucket-owner", s.Account, "--region", s.Region, "--tagging", string(payload))
}
