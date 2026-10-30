package main

import (
	"context"
	"fmt"
	"github.com/lambdawalker/pwa.smolvlm2/backend/internal/bedrock"
	"time"
)

func setupBedrock(infra, stackRegion string) error {
	fallback := stackRegion
	if !bedrock.ValidRegion(fallback) {
		fallback = "us-east-1"
	}
	region := configValue(infra, "bedrockRegion", fallback)
	if !bedrock.ValidRegion(region) {
		return fmt.Errorf("unsupported Bedrock region %q; choose us-east-1, us-east-2, us-west-2 or eu-central-1", region)
	}
	enabled := configValue(infra, "bedrockEnabled", "true")
	if enabled != "true" && enabled != "false" {
		return fmt.Errorf("bedrockEnabled must be true or false")
	}
	if enabled == "true" {
		fmt.Printf("AWS Gemma 4 E2B • Amazon Bedrock • %s. On-demand inference is billed by AWS; no Google API key or GPU instance is needed.\n", region)
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		client, err := bedrock.New(ctx, region)
		if err != nil {
			return err
		}
		if err = client.CheckModel(ctx); err != nil {
			return err
		}
		fmt.Println("Bedrock model metadata verified using your AWS credentials. Inference access for the Lambda role is configured by Pulumi.")
	}
	for _, pair := range [][2]string{{"bedrockRegion", region}, {"bedrockEnabled", enabled}} {
		if err := run(infra, "pulumi", "config", "set", pair[0], pair[1]); err != nil {
			return err
		}
	}
	return nil
}
