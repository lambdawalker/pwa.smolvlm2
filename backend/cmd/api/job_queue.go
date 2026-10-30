package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"log"
	"os"
	"time"
)

var sendClassificationJob = func(ctx context.Context, job ClassificationJob) error {
	if os.Getenv("CLASSIFICATION_QUEUE_URL") == "" {
		return errors.New("classification queue is not configured")
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"id": job.ID, "user": job.User, "sessionId": job.SessionID})
	_, err = sqs.NewFromConfig(cfg).SendMessage(ctx, &sqs.SendMessageInput{QueueUrl: aws.String(os.Getenv("CLASSIFICATION_QUEUE_URL")), MessageBody: aws.String(string(body))})
	return err
}

func dispatchClassification(ctx context.Context, event events.DynamoDBEvent) error {
	for _, record := range event.Records {
		if record.EventName != "INSERT" {
			continue
		}
		kind, ok := record.Change.NewImage["kind"]
		if !ok || kind.String() != "classification-job" {
			continue
		}
		var job ClassificationJob
		if err := json.Unmarshal([]byte(record.Change.NewImage["data"].String()), &job); err != nil {
			return err
		}
		if err := sendClassificationJob(ctx, job); err != nil {
			return err
		}
	}
	return nil
}
func recoverClassificationJobs(ctx context.Context, store recordStore) error {
	jobs, err := store.PendingJobs(ctx, time.Now().Unix())
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if err := sendClassificationJob(ctx, job); err != nil {
			return err
		}
	}
	return nil
}
func backgroundHandler(ctx context.Context, event json.RawMessage) (any, error) {
	var envelope struct {
		Records []struct {
			EventSource string `json:"eventSource"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(event, &envelope); err != nil {
		return nil, err
	}
	if len(envelope.Records) > 0 {
		switch envelope.Records[0].EventSource {
		case "aws:dynamodb":
			var records events.DynamoDBEvent
			if err := json.Unmarshal(event, &records); err != nil {
				return nil, err
			}
			return nil, dispatchClassification(ctx, records)
		case "aws:sqs":
			var records events.SQSEvent
			if err := json.Unmarshal(event, &records); err != nil {
				return nil, err
			}
			store, err := storeFactory(ctx)
			if err != nil {
				return nil, err
			}
			response := events.SQSEventResponse{BatchItemFailures: []events.SQSBatchItemFailure{}}
			for _, record := range records.Records {
				var job ClassificationJob
				err := json.Unmarshal([]byte(record.Body), &job)
				if err == nil {
					err = processClassification(ctx, store, job)
				}
				if err != nil {
					log.Printf("classification job %s: %v", job.ID, err)
					response.BatchItemFailures = append(response.BatchItemFailures, events.SQSBatchItemFailure{ItemIdentifier: record.MessageId})
				}
			}
			return response, nil
		}
	}
	var request events.APIGatewayV2HTTPRequest
	if err := json.Unmarshal(event, &request); err != nil {
		return nil, err
	}
	return handle(ctx, request)
}
