package main

import (
	"strings"
	"sync"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

type infrastructureMocks struct {
	mu        sync.Mutex
	resources map[string]resource.PropertyMap
}

func (m *infrastructureMocks) Call(args pulumi.MockCallArgs) (resource.PropertyMap, error) {
	return args.Args, nil
}
func (m *infrastructureMocks) NewResource(args pulumi.MockResourceArgs) (string, resource.PropertyMap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.resources[args.Name] = args.Inputs
	outputs := resource.PropertyMap{}
	for k, v := range args.Inputs {
		outputs[k] = v
	}
	outputs["arn"] = resource.NewStringProperty("arn:aws:test::123456789012:" + args.Name)
	if _, ok := outputs["name"]; !ok {
		outputs["name"] = resource.NewStringProperty(args.Name)
	}
	outputs["bucketRegionalDomainName"] = resource.NewStringProperty("web.s3.us-east-1.amazonaws.com")
	outputs["domainName"] = resource.NewStringProperty("test.cloudfront.net")
	outputs["apiEndpoint"] = resource.NewStringProperty("https://test.execute-api.us-east-1.amazonaws.com")
	outputs["executionArn"] = resource.NewStringProperty("arn:aws:execute-api:us-east-1:123456789012:api")
	outputs["streamArn"] = resource.NewStringProperty("arn:aws:dynamodb:us-east-1:123456789012:table/audit/stream/test")
	outputs["url"] = resource.NewStringProperty("https://sqs.us-east-1.amazonaws.com/123456789012/queue")
	outputs["invokeArn"] = resource.NewStringProperty("arn:aws:apigateway:us-east-1:lambda:path/invocations")
	if args.Name == "site-certificate" {
		outputs["domainValidationOptions"] = resource.NewArrayProperty([]resource.PropertyValue{resource.NewObjectProperty(resource.NewPropertyMapFromMap(map[string]any{"domainName": "audit.apexfission.com", "resourceRecordName": "_validation.audit.apexfission.com", "resourceRecordValue": "_value.acm-validations.aws.", "resourceRecordType": "CNAME"}))})
	}
	return args.Name + "-id", outputs, nil
}
func TestCustomDomainInfrastructure(t *testing.T) {
	m := &infrastructureMocks{resources: map[string]resource.PropertyMap{}}
	err := pulumi.RunErr(deploy, pulumi.WithMocks("little-lens", "test", m), func(info *pulumi.RunInfo) {
		info.ConfigSecretKeys = []string{"little-lens:geminiApiKey"}
		info.Config = map[string]string{"little-lens:domain": "audit.apexfission.com", "little-lens:cloudflareZoneId": "zone-id", "little-lens:geminiApiKey": "test-key"}
	})
	if err != nil {
		t.Fatal(err)
	}
	r := m.resources
	if r["audit-sessions"]["globalSecondaryIndexes"].ArrayValue()[0].ObjectValue()["name"].StringValue() != "classification-wake" {
		t.Fatal("job recovery must use a bounded wake-time index")
	}
	if !strings.Contains(r["audit-session-access"]["policy"].StringValue(), "/index/classification-wake") {
		t.Fatal("recovery index Query permission missing")
	}
	if !r["audit-sessions"]["streamEnabled"].BoolValue() {
		t.Fatal("job dispatch stream missing")
	}
	if r["classification-queue"]["visibilityTimeoutSeconds"].NumberValue() != 360 || r["classification-worker"]["timeout"].NumberValue() != 60 {
		t.Fatal("queue visibility must allow worker retries")
	}
	if r["classification-worker"]["reservedConcurrentExecutions"].NumberValue() != 2 {
		t.Fatal("worker concurrency must default to two")
	}
	if r["classification-consumer"]["functionResponseTypes"].ArrayValue()[0].StringValue() != "ReportBatchItemFailures" {
		t.Fatal("partial queue failures must be reported")
	}

	if _, inline := r["api"]["code"]; inline {
		t.Fatal("Lambda must not upload inline ZIP code")
	}
	if r["api"]["s3Bucket"].StringValue() == "" || r["api"]["s3Key"].StringValue() == "" || r["api"]["sourceCodeHash"].StringValue() == "" {
		t.Fatal("Lambda artifact reference or hash missing")
	}
	for _, key := range []string{"blockPublicAcls", "blockPublicPolicy", "ignorePublicAcls", "restrictPublicBuckets"} {
		if !r["api-artifacts-private"][resource.PropertyKey(key)].BoolValue() {
			t.Fatal("artifact bucket must be private")
		}
	}
	if r["trash-cleanup"]["scheduleExpression"].StringValue() != "rate(5 minutes)" {
		t.Fatal("missing trash retention schedule")
	}
	if r["trash-cleanup-invoke"]["principal"].StringValue() != "events.amazonaws.com" {
		t.Fatal("cleanup must be invoked by EventBridge")
	}
	env := r["api"]["environment"].ObjectValue()["variables"].ObjectValue()
	if _, old := env["GEMINI_API_KEY"]; old {
		t.Fatal("Google key must not be passed to Lambda")
	}
	if env["BEDROCK_ENABLED"].StringValue() != "true" || env["BEDROCK_REGION"].StringValue() != "us-east-1" {
		t.Fatal("Bedrock must be configured")
	}
	if !strings.Contains(r["api-bedrock"]["policy"].StringValue(), "bedrock-mantle:CreateInference") || !strings.Contains(r["api-bedrock"]["policy"].StringValue(), awsGemmaModel) {
		t.Fatal("model-scoped Bedrock permission missing")
	}
	if r["api"]["timeout"].NumberValue() != 29 {
		t.Fatal("cloud timeout must fit API Gateway")
	}
	for _, key := range []string{"blockPublicAcls", "blockPublicPolicy", "ignorePublicAcls", "restrictPublicBuckets"} {
		if !r["web-private"][resource.PropertyKey(key)].BoolValue() {
			t.Fatalf("public S3 access: %s", key)
		}
	}

	for _, key := range []string{"blockPublicAcls", "blockPublicPolicy", "ignorePublicAcls", "restrictPublicBuckets"} {
		if !r["audit-photos-private"][resource.PropertyKey(key)].BoolValue() {
			t.Fatalf("public photo bucket: %s", key)
		}
	}
	if r["audit-web-client"]["generateSecret"].BoolValue() {
		t.Fatal("browser client cannot hold a secret")
	}
	if r["audit-sessions"]["billingMode"].StringValue() != "PAY_PER_REQUEST" {
		t.Fatal("sessions must use on-demand billing")
	}
	if r["audit-users"]["passwordPolicy"].ObjectValue()["minimumLength"].NumberValue() != 12 {
		t.Fatal("password policy missing")
	}
	if r["site-dns"]["proxied"].BoolValue() || r["certificate-dns"]["proxied"].BoolValue() {
		t.Fatal("Cloudflare records must be DNS-only")
	}
	if r["site-dns"]["name"].StringValue() != "audit.apexfission.com" {
		t.Fatal("wrong hostname")
	}
	if r["certificate-region"]["region"].StringValue() != "us-east-1" {
		t.Fatal("CloudFront certificate must be in us-east-1")
	}
	if r["site"]["aliases"].ArrayValue()[0].StringValue() != "audit.apexfission.com" {
		t.Fatal("missing CloudFront alias")
	}
	if r["site"]["viewerCertificate"].ObjectValue()["acmCertificateArn"].StringValue() == "" {
		t.Fatal("missing validated certificate")
	}
	if r["web-cache"]["minTtl"].NumberValue() != 0 {
		t.Fatal("app shell must revalidate")
	}
	if r["file-index.html"]["cacheControl"].StringValue() != "no-cache" {
		t.Fatal("app shell must not be immutable")
	}
	if r["api"]["runtime"].StringValue() != "provided.al2023" {
		t.Fatal("wrong Lambda runtime")
	}
}

func TestModuleMIMETypes(t *testing.T) {
	for name, want := range map[string]string{"assets/app.js": "application/javascript", "ort/runtime.mjs": "application/javascript", "ort/model.wasm": "application/wasm", "manifest.webmanifest": "application/manifest+json"} {
		if got := assetContentType(name); got != want {
			t.Errorf("%s: %s", name, got)
		}
	}
}
