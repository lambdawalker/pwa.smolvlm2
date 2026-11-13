package main

import "testing"

func TestDeploymentMetadata(t *testing.T) {
	s := settings{Domain: "test.apexfission.com", Stack: "qa"}
	if got := deploymentLabel(s); got != "test.apexfission.com | pwa.smolvlm2" {
		t.Fatal(got)
	}
	merged := mergeBucketTags([]bucketTag{{"Owner", "David"}, {"Project", "old"}}, deploymentTags(s))
	values := map[string]string{}
	for _, tag := range merged {
		values[tag.Key] = tag.Value
	}
	if values["Owner"] != "David" || values["Project"] != "Audit" || values["Stack"] != "qa" {
		t.Fatal(values)
	}
}
