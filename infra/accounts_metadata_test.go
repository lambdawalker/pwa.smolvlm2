package main

import (
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/iam"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"sync"
	"testing"
)

type accountMetadataMocks struct {
	mu       sync.Mutex
	poolTags resource.PropertyValue
}

func (m *accountMetadataMocks) Call(a pulumi.MockCallArgs) (resource.PropertyMap, error) {
	return a.Args, nil
}
func (m *accountMetadataMocks) NewResource(a pulumi.MockResourceArgs) (string, resource.PropertyMap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a.Name == "audit-users" {
		m.poolTags = a.Inputs["tags"]
	}
	out := resource.PropertyMap{}
	for k, v := range a.Inputs {
		out[k] = v
	}
	out["arn"] = resource.NewStringProperty("arn:aws:test::123456789012:" + a.Name)
	out["streamArn"] = resource.NewStringProperty("arn:aws:dynamodb:us-east-1:123456789012:table/audit/stream/test")
	return a.Name, out, nil
}
func TestAccountOwnershipTags(t *testing.T) {
	m := &accountMetadataMocks{}
	err := pulumi.RunErr(func(ctx *pulumi.Context) error {
		role, err := iam.NewRole(ctx, "test-role", &iam.RoleArgs{AssumeRolePolicy: pulumi.String(`{"Version":"2012-10-17","Statement":[]}`)})
		if err != nil {
			return err
		}
		_, err = accountInfrastructure(ctx, role)
		return err
	}, pulumi.WithMocks("little-lens", "qa", m), func(info *pulumi.RunInfo) {
		info.Config = map[string]string{"little-lens:domain": "qa.apexfission.com"}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !m.poolTags.IsObject() {
		t.Fatal("Cognito pool must use the SDK tags property")
	}
	tags := m.poolTags.ObjectValue()
	if tags["Domain"].StringValue() != "qa.apexfission.com" || tags["Repository"].StringValue() != repositoryURL {
		t.Fatal("Cognito ownership tags missing", tags)
	}
}
