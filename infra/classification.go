package main

import (
	"encoding/json"
	"fmt"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/cloudwatch"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/iam"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/lambda"
	"github.com/pulumi/pulumi-aws/sdk/v7/go/aws/sqs"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

type classificationInfrastructure struct {
	Queue         *sqs.Queue
	Permission    *iam.RolePolicy
	Logs          *cloudwatch.LogGroup
	LogPermission *iam.RolePolicy
	Concurrency   int
}

func classificationQueue(ctx *pulumi.Context, role *iam.Role, stream pulumi.StringInput) (classificationInfrastructure, error) {
	out := classificationInfrastructure{Concurrency: 2}
	if value := config.New(ctx, "").GetInt("classificationConcurrency"); value != 0 {
		out.Concurrency = value
	}
	if out.Concurrency < 2 || out.Concurrency > 3 {
		return out, fmt.Errorf("classificationConcurrency must be 2 or 3")
	}
	dlq, err := sqs.NewQueue(ctx, "classification-dead-letter", &sqs.QueueArgs{MessageRetentionSeconds: pulumi.Int(1209600), SqsManagedSseEnabled: pulumi.Bool(true)})
	if err != nil {
		return out, err
	}
	out.Queue, err = sqs.NewQueue(ctx, "classification-queue", &sqs.QueueArgs{VisibilityTimeoutSeconds: pulumi.Int(360), MessageRetentionSeconds: pulumi.Int(345600), SqsManagedSseEnabled: pulumi.Bool(true), RedrivePolicy: dlq.Arn.ApplyT(func(arn string) string {
		data, _ := json.Marshal(map[string]any{"deadLetterTargetArn": arn, "maxReceiveCount": 5})
		return string(data)
	}).(pulumi.StringOutput)})
	if err != nil {
		return out, err
	}
	out.Permission, err = iam.NewRolePolicy(ctx, "classification-queue-access", &iam.RolePolicyArgs{Role: role.ID(), Policy: pulumi.All(out.Queue.Arn, stream).ApplyT(func(v []any) string {
		data, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []any{map[string]any{"Effect": "Allow", "Action": []string{"sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"}, "Resource": v[0]}, map[string]any{"Effect": "Allow", "Action": []string{"dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"}, "Resource": v[1]}, map[string]any{"Effect": "Allow", "Action": "dynamodb:ListStreams", "Resource": "*"}}})
		return string(data)
	}).(pulumi.StringOutput)})
	if err != nil {
		return out, err
	}
	out.Logs, err = cloudwatch.NewLogGroup(ctx, "classification-logs", &cloudwatch.LogGroupArgs{RetentionInDays: pulumi.Int(14)})
	if err != nil {
		return out, err
	}
	out.LogPermission, err = iam.NewRolePolicy(ctx, "classification-logging", &iam.RolePolicyArgs{Role: role.ID(), Policy: out.Logs.Arn.ApplyT(func(arn string) string {
		data, _ := json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": []any{map[string]any{"Effect": "Allow", "Action": []string{"logs:CreateLogStream", "logs:PutLogEvents"}, "Resource": arn + ":*"}}})
		return string(data)
	}).(pulumi.StringOutput)})
	ctx.Export("classificationQueueUrl", out.Queue.Url)
	ctx.Export("classificationDeadLetterQueueUrl", dlq.Url)
	return out, err
}
func classificationMappings(ctx *pulumi.Context, q classificationInfrastructure, api, worker *lambda.Function, stream pulumi.StringInput) ([]pulumi.Resource, error) {
	dispatch, err := lambda.NewEventSourceMapping(ctx, "classification-dispatch", &lambda.EventSourceMappingArgs{EventSourceArn: stream, FunctionName: api.Arn, StartingPosition: pulumi.String("TRIM_HORIZON"), BatchSize: pulumi.Int(1), FilterCriteria: &lambda.EventSourceMappingFilterCriteriaArgs{Filters: lambda.EventSourceMappingFilterCriteriaFilterArray{&lambda.EventSourceMappingFilterCriteriaFilterArgs{Pattern: pulumi.String(`{"eventName":["INSERT"],"dynamodb":{"NewImage":{"kind":{"S":["classification-job"]}}}}`)}}}}, pulumi.DependsOn([]pulumi.Resource{q.Permission}))
	if err != nil {
		return nil, err
	}
	consumer, err := lambda.NewEventSourceMapping(ctx, "classification-consumer", &lambda.EventSourceMappingArgs{EventSourceArn: q.Queue.Arn, FunctionName: worker.Arn, BatchSize: pulumi.Int(1), FunctionResponseTypes: pulumi.ToStringArray([]string{"ReportBatchItemFailures"}), ScalingConfig: &lambda.EventSourceMappingScalingConfigArgs{MaximumConcurrency: pulumi.Int(q.Concurrency)}}, pulumi.DependsOn([]pulumi.Resource{q.Permission}))
	if err != nil {
		return nil, err
	}
	return []pulumi.Resource{worker, dispatch, consumer}, nil
}
