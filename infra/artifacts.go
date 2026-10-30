package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/s3"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"os"
)

// Stage the ZIP in S3 so UpdateFunctionCode sends a small S3 reference rather
// than a signed inline upload that can expire on a slow connection.
func lambdaArtifact(ctx *pulumi.Context) (*s3.BucketV2, *s3.BucketObjectv2, string, error) {
	data, err := os.ReadFile("../backend/build/backend.zip")
	if err != nil {
		return nil, nil, "", err
	}
	sum := sha256.Sum256(data)
	bucket, err := s3.NewBucketV2(ctx, "api-artifacts", &s3.BucketV2Args{})
	if err != nil {
		return nil, nil, "", err
	}
	block, err := s3.NewBucketPublicAccessBlock(ctx, "api-artifacts-private", &s3.BucketPublicAccessBlockArgs{Bucket: bucket.ID(), BlockPublicAcls: pulumi.Bool(true), BlockPublicPolicy: pulumi.Bool(true), IgnorePublicAcls: pulumi.Bool(true), RestrictPublicBuckets: pulumi.Bool(true)})
	if err != nil {
		return nil, nil, "", err
	}
	object, err := s3.NewBucketObjectv2(ctx, "api-code", &s3.BucketObjectv2Args{Bucket: bucket.ID(), Key: pulumi.String("lambda/" + hex.EncodeToString(sum[:]) + ".zip"), Source: pulumi.NewFileAsset("../backend/build/backend.zip"), ContentType: pulumi.String("application/zip"), ServerSideEncryption: pulumi.String("AES256")}, pulumi.DependsOn([]pulumi.Resource{block}))
	if err != nil {
		return nil, nil, "", err
	}
	return bucket, object, base64.StdEncoding.EncodeToString(sum[:]), nil
}
