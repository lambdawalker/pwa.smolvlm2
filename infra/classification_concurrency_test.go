package main

import (
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/iam"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/lambda"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"sync"
	"testing"
)

type concurrencyMocks struct {
	mu    sync.Mutex
	limit resource.PropertyValue
}

func (m *concurrencyMocks) Call(a pulumi.MockCallArgs) (resource.PropertyMap, error) {
	return a.Args, nil
}
func (m *concurrencyMocks) NewResource(a pulumi.MockResourceArgs) (string, resource.PropertyMap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a.Name == "classification-consumer" {
		m.limit = a.Inputs["scalingConfig"]
	}
	out := resource.PropertyMap{}
	for k, v := range a.Inputs {
		out[k] = v
	}
	out["arn"] = resource.NewStringProperty("arn:aws:test::123456789012:" + a.Name)
	out["url"] = resource.NewStringProperty("https://sqs.us-east-1.amazonaws.com/123456789012/queue")
	return a.Name, out, nil
}
func TestSQSConcurrencyLimit(t *testing.T) {
	for _, n := range []int{2, 3} {
		m := &concurrencyMocks{}
		err := pulumi.RunErr(func(ctx *pulumi.Context) error {
			role, err := iam.NewRole(ctx, "test-role", &iam.RoleArgs{AssumeRolePolicy: pulumi.String(`{"Version":"2012-10-17","Statement":[]}`)})
			if err != nil {
				return err
			}
			q, err := classificationQueue(ctx, role, pulumi.String("arn:aws:dynamodb:us-east-1:123456789012:table/audit/stream/test"))
			if err != nil {
				return err
			}
			fn, err := lambda.NewFunction(ctx, "test-function", &lambda.FunctionArgs{Role: role.Arn, Runtime: pulumi.String("provided.al2023"), Handler: pulumi.String("bootstrap"), S3Bucket: pulumi.String("artifacts"), S3Key: pulumi.String("code.zip")})
			if err != nil {
				return err
			}
			_, err = classificationMappings(ctx, q, fn, fn, pulumi.String("arn:aws:dynamodb:us-east-1:123456789012:table/audit/stream/test"))
			return err
		}, pulumi.WithMocks("little-lens", "test", m), func(info *pulumi.RunInfo) {
			if n == 3 {
				info.Config = map[string]string{"little-lens:classificationConcurrency": "3"}
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		if m.limit.ObjectValue()["maximumConcurrency"].NumberValue() != float64(n) {
			t.Fatal("queue limit lost", m.limit)
		}
	}
}
