package main

import (
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"testing"
)

func TestMetadataUsesConfiguredDomain(t *testing.T) {
	m := &infrastructureMocks{resources: map[string]resource.PropertyMap{}}
	err := pulumi.RunErr(func(ctx *pulumi.Context) error {
		if projectLabel(ctx) != "qa.apexfission.com | pwa.smolvlm2" {
			t.Error("configured domain ignored")
		}
		if projectTags(ctx)["Stack"] != pulumi.String("qa") {
			t.Error("stack missing")
		}
		return nil
	}, pulumi.WithMocks("little-lens", "qa", m), func(info *pulumi.RunInfo) {
		info.Config = map[string]string{"little-lens:domain": "qa.apexfission.com"}
	})
	if err != nil {
		t.Fatal(err)
	}
}
