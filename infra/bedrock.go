package main

import (
	"encoding/json"
	"fmt"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/iam"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

const awsGemmaModel = "google.gemma-4-e2b"

func bedrockInfrastructure(ctx *pulumi.Context, role *iam.Role) (*iam.RolePolicy, string, bool, error) {
	cfg := config.New(ctx, "")
	region := cfg.Get("bedrockRegion")
	if region == "" {
		region = config.New(ctx, "aws").Get("region")
	}
	if region == "" {
		region = "us-east-1"
	}
	switch region {
	case "us-east-1", "us-east-2", "us-west-2", "eu-central-1":
	default:
		return nil, "", false, fmt.Errorf("Gemma 4 E2B requires bedrockRegion us-east-1, us-east-2, us-west-2 or eu-central-1")
	}
	enabled := cfg.Get("bedrockEnabled") != "false"
	if !enabled {
		return nil, region, false, nil
	}
	policy, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []any{map[string]any{"Effect": "Allow", "Action": "bedrock-mantle:CreateInference", "Resource": "*", "Condition": map[string]any{"StringEquals": map[string]string{"bedrock-mantle:Model": awsGemmaModel, "aws:RequestedRegion": region}}}}})
	permission, err := iam.NewRolePolicy(ctx, "api-bedrock", &iam.RolePolicyArgs{Role: role.ID(), Policy: pulumi.String(string(policy))})
	return permission, region, enabled, err
}
