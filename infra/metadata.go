package main

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

const repositoryName = "pwa.smolvlm2"
const repositoryURL = "https://github.com/lambdawalker/pwa.smolvlm2"

func projectDomain(ctx *pulumi.Context) string {
	domain := config.New(ctx, "").Get("domain")
	if domain == "" {
		domain = "audit.apexfission.com"
	}
	return domain
}
func projectLabel(ctx *pulumi.Context) string { return projectDomain(ctx) + " | " + repositoryName }
func projectTags(ctx *pulumi.Context) pulumi.StringMap {
	return pulumi.StringMap{
		"Project": pulumi.String("Audit"), "Repository": pulumi.String(repositoryURL),
		"Domain": pulumi.String(projectDomain(ctx)), "Stack": pulumi.String(ctx.Stack()),
		"ManagedBy": pulumi.String("Pulumi"),
	}
}
func artifactMetadata(ctx *pulumi.Context) pulumi.StringMap {
	return pulumi.StringMap{
		"project": pulumi.String("Audit"), "repository": pulumi.String(repositoryURL),
		"domain": pulumi.String(projectDomain(ctx)), "stack": pulumi.String(ctx.Stack()),
		"project-label": pulumi.String(projectLabel(ctx)),
	}
}
