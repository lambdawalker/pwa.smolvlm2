package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/acm"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/apigatewayv2"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/cloudfront"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/cloudwatch"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/iam"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/lambda"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/s3"
	"github.com/pulumi/pulumi-cloudflare/sdk/v6/go/cloudflare"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() { pulumi.Run(deploy) }
func deploy(ctx *pulumi.Context) error {
	cfg := config.New(ctx, "")
	for _, path := range []string{"../dist/index.html", "../backend/build/backend.zip"} {
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("missing build artifact %s: run npm run build:aws from the repository root: %w", path, err)
		}
	}
	bucket, err := s3.NewBucketV2(ctx, "web", &s3.BucketV2Args{})
	if err != nil {
		return err
	}
	_, err = s3.NewBucketPublicAccessBlock(ctx, "web-private", &s3.BucketPublicAccessBlockArgs{Bucket: bucket.ID(), BlockPublicAcls: pulumi.Bool(true), BlockPublicPolicy: pulumi.Bool(true), IgnorePublicAcls: pulumi.Bool(true), RestrictPublicBuckets: pulumi.Bool(true)})
	if err != nil {
		return err
	}
	oac, err := cloudfront.NewOriginAccessControl(ctx, "web-access", &cloudfront.OriginAccessControlArgs{OriginAccessControlOriginType: pulumi.String("s3"), SigningBehavior: pulumi.String("always"), SigningProtocol: pulumi.String("sigv4")})
	if err != nil {
		return err
	}
	role, err := iam.NewRole(ctx, "api-role", &iam.RoleArgs{AssumeRolePolicy: pulumi.String(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}`)})
	if err != nil {
		return err
	}
	logs, err := cloudwatch.NewLogGroup(ctx, "api-logs", &cloudwatch.LogGroupArgs{RetentionInDays: pulumi.Int(14)})
	if err != nil {
		return err
	}
	policy, err := iam.NewRolePolicy(ctx, "api-logging", &iam.RolePolicyArgs{Role: role.ID(), Policy: logs.Arn.ApplyT(func(arn string) string {
		b, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []any{map[string]any{"Effect": "Allow", "Action": []string{"logs:CreateLogStream", "logs:PutLogEvents"}, "Resource": arn + ":*"}}})
		return string(b)
	}).(pulumi.StringOutput)})
	if err != nil {
		return err
	}
	fn, err := lambda.NewFunction(ctx, "api", &lambda.FunctionArgs{Role: role.Arn, Runtime: pulumi.String("provided.al2023"), Handler: pulumi.String("bootstrap"), Architectures: pulumi.StringArray{pulumi.String("arm64")}, Code: pulumi.NewFileArchive("../backend/build/backend.zip"), MemorySize: pulumi.Int(256), Timeout: pulumi.Int(29), Environment: &lambda.FunctionEnvironmentArgs{Variables: pulumi.StringMap{"GEMINI_API_KEY": cfg.GetSecret("geminiApiKey"), "SITE_ORIGIN": pulumi.String("https://" + cfg.Get("domain"))}}, LoggingConfig: &lambda.FunctionLoggingConfigArgs{LogFormat: pulumi.String("Text"), LogGroup: logs.Name}}, pulumi.DependsOn([]pulumi.Resource{policy}))
	if err != nil {
		return err
	}
	api, err := apigatewayv2.NewApi(ctx, "http-api", &apigatewayv2.ApiArgs{ProtocolType: pulumi.String("HTTP")})
	if err != nil {
		return err
	}
	integration, err := apigatewayv2.NewIntegration(ctx, "api-integration", &apigatewayv2.IntegrationArgs{ApiId: api.ID(), IntegrationType: pulumi.String("AWS_PROXY"), IntegrationUri: fn.InvokeArn, PayloadFormatVersion: pulumi.String("2.0")})
	if err != nil {
		return err
	}
	route, err := apigatewayv2.NewRoute(ctx, "api-route", &apigatewayv2.RouteArgs{ApiId: api.ID(), RouteKey: pulumi.String("ANY /api/{proxy+}"), Target: pulumi.Sprintf("integrations/%s", integration.ID())})
	if err != nil {
		return err
	}
	_, err = apigatewayv2.NewStage(ctx, "api-stage", &apigatewayv2.StageArgs{ApiId: api.ID(), Name: pulumi.String("$default"), AutoDeploy: pulumi.Bool(true), DefaultRouteSettings: &apigatewayv2.StageDefaultRouteSettingsArgs{ThrottlingBurstLimit: pulumi.Int(20), ThrottlingRateLimit: pulumi.Float64(10)}}, pulumi.DependsOn([]pulumi.Resource{route}))
	if err != nil {
		return err
	}
	_, err = lambda.NewPermission(ctx, "api-invoke", &lambda.PermissionArgs{Action: pulumi.String("lambda:InvokeFunction"), Function: fn.Name, Principal: pulumi.String("apigateway.amazonaws.com"), SourceArn: pulumi.Sprintf("%s/*/*/api/*", api.ExecutionArn)})
	if err != nil {
		return err
	}
	// A zero minimum TTL lets Cache-Control:no-cache on the app shell take effect.
	cache, err := cloudfront.NewCachePolicy(ctx, "web-cache", &cloudfront.CachePolicyArgs{MinTtl: pulumi.Int(0), DefaultTtl: pulumi.Int(0), MaxTtl: pulumi.Int(31536000), ParametersInCacheKeyAndForwardedToOrigin: &cloudfront.CachePolicyParametersInCacheKeyAndForwardedToOriginArgs{EnableAcceptEncodingGzip: pulumi.Bool(true), EnableAcceptEncodingBrotli: pulumi.Bool(true), CookiesConfig: &cloudfront.CachePolicyParametersInCacheKeyAndForwardedToOriginCookiesConfigArgs{CookieBehavior: pulumi.String("none")}, HeadersConfig: &cloudfront.CachePolicyParametersInCacheKeyAndForwardedToOriginHeadersConfigArgs{HeaderBehavior: pulumi.String("none")}, QueryStringsConfig: &cloudfront.CachePolicyParametersInCacheKeyAndForwardedToOriginQueryStringsConfigArgs{QueryStringBehavior: pulumi.String("none")}}})
	if err != nil {
		return err
	}
	domain := cfg.Get("domain")
	aliases := pulumi.StringArray{}
	certificate := &cloudfront.DistributionViewerCertificateArgs{CloudfrontDefaultCertificate: pulumi.Bool(true)}
	if domain != "" {
		zone := cfg.Require("cloudflareZoneId")
		east, err := aws.NewProvider(ctx, "certificate-region", &aws.ProviderArgs{Region: pulumi.String("us-east-1")})
		if err != nil {
			return err
		}
		cert, err := acm.NewCertificate(ctx, "site-certificate", &acm.CertificateArgs{DomainName: pulumi.String(domain), ValidationMethod: pulumi.String("DNS")}, pulumi.Provider(east))
		if err != nil {
			return err
		}
		option := cert.DomainValidationOptions.Index(pulumi.Int(0))
		record, err := cloudflare.NewDnsRecord(ctx, "certificate-dns", &cloudflare.DnsRecordArgs{ZoneId: pulumi.String(zone), Name: option.ResourceRecordName().Elem(), Content: option.ResourceRecordValue(), Type: option.ResourceRecordType().Elem(), Ttl: pulumi.Float64(60), Proxied: pulumi.Bool(false)})
		if err != nil {
			return err
		}
		validated, err := acm.NewCertificateValidation(ctx, "validated-certificate", &acm.CertificateValidationArgs{CertificateArn: cert.Arn, ValidationRecordFqdns: pulumi.StringArray{record.Name}}, pulumi.Provider(east))
		if err != nil {
			return err
		}
		aliases = append(aliases, pulumi.String(domain))
		certificate = &cloudfront.DistributionViewerCertificateArgs{AcmCertificateArn: validated.CertificateArn, SslSupportMethod: pulumi.String("sni-only"), MinimumProtocolVersion: pulumi.String("TLSv1.2_2021")}
	}
	distribution, err := cloudfront.NewDistribution(ctx, "site", &cloudfront.DistributionArgs{
		Aliases: aliases, Enabled: pulumi.Bool(true), IsIpv6Enabled: pulumi.Bool(true), DefaultRootObject: pulumi.String("index.html"), PriceClass: pulumi.String("PriceClass_100"),
		Origins: cloudfront.DistributionOriginArray{
			&cloudfront.DistributionOriginArgs{OriginId: pulumi.String("web"), DomainName: bucket.BucketRegionalDomainName, OriginAccessControlId: oac.ID()},
			&cloudfront.DistributionOriginArgs{OriginId: pulumi.String("api"), DomainName: api.ApiEndpoint.ApplyT(func(endpoint string) string { return strings.TrimPrefix(endpoint, "https://") }).(pulumi.StringOutput), CustomOriginConfig: &cloudfront.DistributionOriginCustomOriginConfigArgs{HttpPort: pulumi.Int(80), HttpsPort: pulumi.Int(443), OriginProtocolPolicy: pulumi.String("https-only"), OriginSslProtocols: pulumi.StringArray{pulumi.String("TLSv1.2")}}},
		},
		DefaultCacheBehavior:  &cloudfront.DistributionDefaultCacheBehaviorArgs{TargetOriginId: pulumi.String("web"), ViewerProtocolPolicy: pulumi.String("redirect-to-https"), AllowedMethods: pulumi.ToStringArray([]string{"GET", "HEAD", "OPTIONS"}), CachedMethods: pulumi.ToStringArray([]string{"GET", "HEAD"}), CachePolicyId: cache.ID(), Compress: pulumi.Bool(true)},
		OrderedCacheBehaviors: cloudfront.DistributionOrderedCacheBehaviorArray{&cloudfront.DistributionOrderedCacheBehaviorArgs{PathPattern: pulumi.String("/api/*"), TargetOriginId: pulumi.String("api"), ViewerProtocolPolicy: pulumi.String("https-only"), AllowedMethods: pulumi.ToStringArray([]string{"GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"}), CachedMethods: pulumi.ToStringArray([]string{"GET", "HEAD"}), CachePolicyId: pulumi.String("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"), OriginRequestPolicyId: pulumi.String("b689b0a8-53d0-40ab-baf2-68738e2966ac")}},
		Restrictions:          &cloudfront.DistributionRestrictionsArgs{GeoRestriction: &cloudfront.DistributionRestrictionsGeoRestrictionArgs{RestrictionType: pulumi.String("none")}}, ViewerCertificate: certificate,
	})
	if err != nil {
		return err
	}
	_, err = s3.NewBucketPolicy(ctx, "web-cloudfront-only", &s3.BucketPolicyArgs{Bucket: bucket.ID(), Policy: pulumi.All(bucket.Arn, distribution.Arn).ApplyT(func(args []any) string {
		b, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []any{map[string]any{"Effect": "Allow", "Principal": map[string]string{"Service": "cloudfront.amazonaws.com"}, "Action": "s3:GetObject", "Resource": args[0].(string) + "/*", "Condition": map[string]any{"StringEquals": map[string]any{"AWS:SourceArn": args[1]}}}}})
		return string(b)
	}).(pulumi.StringOutput)})
	if err != nil {
		return err
	}
	err = filepath.WalkDir("../dist", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		key, err := filepath.Rel("../dist", path)
		if err != nil {
			return err
		}
		key = filepath.ToSlash(key)
		contentType := assetContentType(key)
		cacheControl := "no-cache"
		if strings.HasPrefix(key, "assets/") {
			cacheControl = "public, max-age=31536000, immutable"
		}
		_, err = s3.NewBucketObjectv2(ctx, "file-"+key, &s3.BucketObjectv2Args{Bucket: bucket.ID(), Key: pulumi.String(key), Source: pulumi.NewFileAsset(path), ContentType: pulumi.String(contentType), CacheControl: pulumi.String(cacheControl)})
		return err
	})
	if err != nil {
		return err
	}
	siteURL := pulumi.Sprintf("https://%s", distribution.DomainName)
	if domain != "" {
		_, err = cloudflare.NewDnsRecord(ctx, "site-dns", &cloudflare.DnsRecordArgs{ZoneId: pulumi.String(cfg.Require("cloudflareZoneId")), Name: pulumi.String(domain), Content: distribution.DomainName, Type: pulumi.String("CNAME"), Ttl: pulumi.Float64(60), Proxied: pulumi.Bool(false)})
		if err != nil {
			return err
		}
		siteURL = pulumi.Sprintf("https://%s", domain)
	}
	ctx.Export("url", siteURL)
	ctx.Export("healthUrl", pulumi.Sprintf("%s/api/health", siteURL))
	ctx.Export("cloudfrontUrl", pulumi.Sprintf("https://%s", distribution.DomainName))
	ctx.Export("distributionId", distribution.ID())
	ctx.Export("bucketName", bucket.ID())
	return nil
}

// Avoid OS-specific MIME tables (especially Windows .js/.mjs associations).
func assetContentType(key string) string {
	switch filepath.Ext(key) {
	case ".js", ".mjs":
		return "application/javascript"
	case ".wasm":
		return "application/wasm"
	case ".css":
		return "text/css"
	case ".html":
		return "text/html; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json"
	case ".json":
		return "application/json"
	}
	if value := mime.TypeByExtension(filepath.Ext(key)); value != "" {
		return value
	}
	return "application/octet-stream"
}
