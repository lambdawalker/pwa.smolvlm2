package main

import (
	"encoding/json"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/cognito"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/dynamodb"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/iam"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/s3"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func accountInfrastructure(ctx *pulumi.Context, role *iam.Role) (pulumi.StringMap, error) {
	pool, e := cognito.NewUserPool(ctx, "audit-users", &cognito.UserPoolArgs{UsernameAttributes: pulumi.ToStringArray([]string{"email"}), AutoVerifiedAttributes: pulumi.ToStringArray([]string{"email"}), UsernameConfiguration: &cognito.UserPoolUsernameConfigurationArgs{CaseSensitive: pulumi.Bool(false)}, PasswordPolicy: &cognito.UserPoolPasswordPolicyArgs{MinimumLength: pulumi.Int(12), RequireLowercase: pulumi.Bool(true), RequireUppercase: pulumi.Bool(true), RequireNumbers: pulumi.Bool(true), RequireSymbols: pulumi.Bool(false)}})
	if e != nil {
		return nil, e
	}
	client, e := cognito.NewUserPoolClient(ctx, "audit-web-client", &cognito.UserPoolClientArgs{UserPoolId: pool.ID(), GenerateSecret: pulumi.Bool(false), ExplicitAuthFlows: pulumi.ToStringArray([]string{"ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"}), PreventUserExistenceErrors: pulumi.String("ENABLED"), AccessTokenValidity: pulumi.Int(15), IdTokenValidity: pulumi.Int(15), RefreshTokenValidity: pulumi.Int(30), TokenValidityUnits: &cognito.UserPoolClientTokenValidityUnitsArgs{AccessToken: pulumi.String("minutes"), IdToken: pulumi.String("minutes"), RefreshToken: pulumi.String("days")}, EnableTokenRevocation: pulumi.Bool(true)})
	if e != nil {
		return nil, e
	}
	table, e := dynamodb.NewTable(ctx, "audit-sessions", &dynamodb.TableArgs{BillingMode: pulumi.String("PAY_PER_REQUEST"), HashKey: pulumi.String("pk"), RangeKey: pulumi.String("sk"), Attributes: dynamodb.TableAttributeArray{&dynamodb.TableAttributeArgs{Name: pulumi.String("pk"), Type: pulumi.String("S")}, &dynamodb.TableAttributeArgs{Name: pulumi.String("sk"), Type: pulumi.String("S")}}, ServerSideEncryption: &dynamodb.TableServerSideEncryptionArgs{Enabled: pulumi.Bool(true)}})
	if e != nil {
		return nil, e
	}
	bucket, e := s3.NewBucketV2(ctx, "audit-photos", &s3.BucketV2Args{})
	if e != nil {
		return nil, e
	}
	_, e = s3.NewBucketPublicAccessBlock(ctx, "audit-photos-private", &s3.BucketPublicAccessBlockArgs{Bucket: bucket.ID(), BlockPublicAcls: pulumi.Bool(true), BlockPublicPolicy: pulumi.Bool(true), IgnorePublicAcls: pulumi.Bool(true), RestrictPublicBuckets: pulumi.Bool(true)})
	if e != nil {
		return nil, e
	}
	_, e = s3.NewBucketServerSideEncryptionConfigurationV2(ctx, "audit-photos-encryption", &s3.BucketServerSideEncryptionConfigurationV2Args{Bucket: bucket.ID(), Rules: s3.BucketServerSideEncryptionConfigurationV2RuleArray{&s3.BucketServerSideEncryptionConfigurationV2RuleArgs{ApplyServerSideEncryptionByDefault: &s3.BucketServerSideEncryptionConfigurationV2RuleApplyServerSideEncryptionByDefaultArgs{SseAlgorithm: pulumi.String("AES256")}}}})
	if e != nil {
		return nil, e
	}
	domain := config.New(ctx, "").Get("domain")
	origins := []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	if domain != "" {
		origins = append(origins, "https://"+domain)
	}
	_, e = s3.NewBucketCorsConfigurationV2(ctx, "audit-photos-cors", &s3.BucketCorsConfigurationV2Args{Bucket: bucket.ID(), CorsRules: s3.BucketCorsConfigurationV2CorsRuleArray{&s3.BucketCorsConfigurationV2CorsRuleArgs{AllowedOrigins: pulumi.ToStringArray(origins), AllowedMethods: pulumi.ToStringArray([]string{"GET", "PUT", "HEAD"}), AllowedHeaders: pulumi.ToStringArray([]string{"content-type"}), ExposeHeaders: pulumi.ToStringArray([]string{"ETag"}), MaxAgeSeconds: pulumi.Int(300)}}})
	if e != nil {
		return nil, e
	}
	_, e = iam.NewRolePolicy(ctx, "audit-session-access", &iam.RolePolicyArgs{Role: role.ID(), Policy: pulumi.All(table.Arn, bucket.Arn).ApplyT(func(v []any) string {
		b, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []any{map[string]any{"Effect": "Allow", "Action": []string{"dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem"}, "Resource": v[0]}, map[string]any{"Effect": "Allow", "Action": []string{"s3:GetObject", "s3:PutObject", "s3:DeleteObject"}, "Resource": v[1].(string) + "/*"}}})
		return string(b)
	}).(pulumi.StringOutput)})
	if e != nil {
		return nil, e
	}
	ctx.Export("userPoolId", pool.ID())
	ctx.Export("userPoolClientId", client.ID())
	ctx.Export("photosBucket", bucket.ID())
	ctx.Export("sessionsTable", table.Name)
	return pulumi.StringMap{"COGNITO_POOL_ID": pool.ID(), "COGNITO_CLIENT_ID": client.ID(), "SESSIONS_TABLE": table.Name, "PHOTOS_BUCKET": bucket.ID()}, nil
}
