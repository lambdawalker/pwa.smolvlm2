package main

import (
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
	outputs["invokeArn"] = resource.NewStringProperty("arn:aws:apigateway:us-east-1:lambda:path/invocations")
	if args.Name == "site-certificate" {
		outputs["domainValidationOptions"] = resource.NewArrayProperty([]resource.PropertyValue{resource.NewObjectProperty(resource.NewPropertyMapFromMap(map[string]any{"domainName": "audit.apexfission.com", "resourceRecordName": "_validation.audit.apexfission.com", "resourceRecordValue": "_value.acm-validations.aws.", "resourceRecordType": "CNAME"}))})
	}
	return args.Name + "-id", outputs, nil
}
func TestCustomDomainInfrastructure(t *testing.T) {
	m := &infrastructureMocks{resources: map[string]resource.PropertyMap{}}
	err := pulumi.RunErr(deploy, pulumi.WithMocks("little-lens", "test", m), func(info *pulumi.RunInfo) {
		info.Config = map[string]string{"little-lens:domain": "audit.apexfission.com", "little-lens:cloudflareZoneId": "zone-id"}
	})
	if err != nil {
		t.Fatal(err)
	}
	r := m.resources
	for _, key := range []string{"blockPublicAcls", "blockPublicPolicy", "ignorePublicAcls", "restrictPublicBuckets"} {
		if !r["web-private"][resource.PropertyKey(key)].BoolValue() {
			t.Fatalf("public S3 access: %s", key)
		}
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
