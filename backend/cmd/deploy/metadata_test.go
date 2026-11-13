package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

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

func TestBucketTagProcess(t *testing.T) {
	if os.Getenv("AUDIT_TAG_HELPER") != "1" {
		return
	}
	mode := os.Getenv("AUDIT_TAG_MODE")
	if mode == "empty" {
		fmt.Fprintln(os.Stderr, "An error occurred (NoSuchTagSet) when calling GetBucketTagging")
		os.Exit(1)
	}
	if mode == "denied" {
		fmt.Fprintln(os.Stderr, "AccessDenied")
		os.Exit(1)
	}
	if mode == "invalid" {
		fmt.Print("TAGSET text instead of JSON")
		os.Exit(0)
	}
	args := strings.Join(os.Args, " ")
	if !strings.Contains(args, "--output json") || !strings.Contains(args, "--no-cli-pager") {
		fmt.Print("TAGSET text from configured output mode")
		os.Exit(0)
	}
	fmt.Fprintln(os.Stderr, "This is an AWS CLI warning.")
	fmt.Print(`{"TagSet":[{"Key":"Owner","Value":"David"}]}`)
	os.Exit(0)
}
func TestReadStateBucketTags(t *testing.T) {
	for _, mode := range []string{"json", "empty", "denied", "invalid"} {
		t.Run(mode, func(t *testing.T) {
			args := append([]string{"-test.run=^TestBucketTagProcess$", "--"}, stateBucketTagReadArgs(settings{StateBucket: "test", Account: "123", Region: "us-east-1"})...)
			cmd := exec.Command(os.Args[0], args...)
			cmd.Env = append(os.Environ(), "AUDIT_TAG_HELPER=1", "AUDIT_TAG_MODE="+mode)
			tags, err := readStateBucketTags(cmd)
			switch mode {
			case "json":
				if err != nil || len(tags) != 1 || tags[0].Value != "David" {
					t.Fatal(tags, err)
				}
			case "empty":
				if err != nil || len(tags) != 0 {
					t.Fatal(tags, err)
				}
			default:
				if err == nil {
					t.Fatal("invalid/error response must stop deployment")
				}
			}
		})
	}
}
