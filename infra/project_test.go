package main

import (
	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
	"testing"
)

func TestProjectConfigurationLoads(t *testing.T) {
	if _, err := workspace.LoadProject("Pulumi.yaml"); err != nil {
		t.Fatal(err)
	}
}
