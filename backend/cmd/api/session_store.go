package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dt "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"io"
	"os"
	"strconv"
	"time"
)

var errConflict = errors.New("session conflict")

type recordStore interface {
	PutPhotoJob(context.Context, string, Session, Photo, int, ClassificationJob) error
	ObjectBytes(context.Context, string, int64) ([]byte, error)
	PendingJobs(context.Context, int64) ([]ClassificationJob, error)

	ObjectSHA256(context.Context, string) (string, int64, error)
	MarkShredded(context.Context, string, string, []byte) error
	TrashCandidates(context.Context, int64) ([]trashRecord, error)
	Get(context.Context, string, string) ([]byte, error)
	List(context.Context, string, string) ([][]byte, error)
	Put(context.Context, string, string, []byte, int, int) error
	PutPhoto(context.Context, string, string, int, string, string, []byte, int, int) error
	Delete(context.Context, string, string) error
	URL(context.Context, string, string, string) (string, error)
	Size(context.Context, string) (int64, error)
	RemoveObject(context.Context, string) error
}

var storeFactory = func(ctx context.Context) (recordStore, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return &awsRecords{d: dynamodb.NewFromConfig(cfg), s: s3.NewFromConfig(cfg, func(o *s3.Options) { o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired })}, nil
}

type awsRecords struct {
	d *dynamodb.Client
	s *s3.Client
}

func av(v string) dt.AttributeValue { return &dt.AttributeValueMemberS{Value: v} }
func keys(owner, key string) map[string]dt.AttributeValue {
	return map[string]dt.AttributeValue{"pk": av(owner), "sk": av(key)}
}
func (s *awsRecords) Get(ctx context.Context, owner, key string) ([]byte, error) {
	v, e := s.d.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(os.Getenv("SESSIONS_TABLE")), Key: keys(owner, key), ConsistentRead: aws.Bool(true)})
	if e != nil {
		return nil, e
	}
	if d, ok := v.Item["data"].(*dt.AttributeValueMemberS); ok {
		return []byte(d.Value), nil
	}
	return nil, nil
}
func (s *awsRecords) List(ctx context.Context, owner, prefix string) ([][]byte, error) {
	out := [][]byte{}
	var start map[string]dt.AttributeValue
	for {
		v, e := s.d.Query(ctx, &dynamodb.QueryInput{TableName: aws.String(os.Getenv("SESSIONS_TABLE")), KeyConditionExpression: aws.String("pk = :p AND begins_with(sk, :s)"), ExpressionAttributeValues: map[string]dt.AttributeValue{":p": av(owner), ":s": av(prefix)}, ConsistentRead: aws.Bool(true), ExclusiveStartKey: start})
		if e != nil {
			return nil, e
		}
		for _, i := range v.Items {
			if d, ok := i["data"].(*dt.AttributeValueMemberS); ok {
				out = append(out, []byte(d.Value))
			}
		}
		if len(v.LastEvaluatedKey) == 0 {
			return out, nil
		}
		start = v.LastEvaluatedKey
	}
}
func (s *awsRecords) Put(ctx context.Context, owner, key string, data []byte, revision, expected int) error {
	item := keys(owner, key)
	item["data"] = av(string(data))
	addPurgeTime(item, data)
	addJobAttributes(item, data)
	item["revision"] = &dt.AttributeValueMemberN{Value: strconv.Itoa(revision)}
	in := &dynamodb.PutItemInput{TableName: aws.String(os.Getenv("SESSIONS_TABLE")), Item: item, ConditionExpression: aws.String("attribute_not_exists(pk)")}
	if expected > 0 {
		in.ConditionExpression = aws.String("revision = :r")
		in.ExpressionAttributeValues = map[string]dt.AttributeValue{":r": &dt.AttributeValueMemberN{Value: strconv.Itoa(expected)}}
	}
	_, e := s.d.PutItem(ctx, in)
	var conflict *dt.ConditionalCheckFailedException
	if errors.As(e, &conflict) {
		return errConflict
	}
	return e
}
func (s *awsRecords) Delete(ctx context.Context, o, k string) error {
	_, e := s.d.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: aws.String(os.Getenv("SESSIONS_TABLE")), Key: keys(o, k)})
	return e
}
func (s *awsRecords) URL(ctx context.Context, method, key, mime string) (string, error) {
	p := s3.NewPresignClient(s.s)
	if method == "PUT" {
		v, e := p.PresignPutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(os.Getenv("PHOTOS_BUCKET")), Key: aws.String(key), ContentType: aws.String(mime)}, s3.WithPresignExpires(5*time.Minute))
		if e != nil {
			return "", e
		}
		return v.URL, nil
	}
	v, e := p.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(os.Getenv("PHOTOS_BUCKET")), Key: aws.String(key)}, s3.WithPresignExpires(15*time.Minute))
	if e != nil {
		return "", e
	}
	return v.URL, nil
}
func (s *awsRecords) Size(ctx context.Context, k string) (int64, error) {
	v, e := s.s.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(os.Getenv("PHOTOS_BUCKET")), Key: aws.String(k)})
	if e != nil {
		return 0, e
	}
	return aws.ToInt64(v.ContentLength), nil
}
func (s *awsRecords) RemoveObject(ctx context.Context, k string) error {
	_, e := s.s.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(os.Getenv("PHOTOS_BUCKET")), Key: aws.String(k)})
	return e
}

// Checking the parent revision in the same transaction prevents an in-flight
// upload/update from creating metadata after session deletion has started.
func (s *awsRecords) PutPhoto(ctx context.Context, parentOwner, parentKey string, parentRevision int, owner, key string, data []byte, revision, expected int) error {
	table := aws.String(os.Getenv("SESSIONS_TABLE"))
	item := keys(owner, key)
	item["data"] = av(string(data))
	addPurgeTime(item, data)
	addJobAttributes(item, data)
	item["revision"] = &dt.AttributeValueMemberN{Value: strconv.Itoa(revision)}
	put := &dt.Put{TableName: table, Item: item, ConditionExpression: aws.String("attribute_not_exists(pk)")}
	if expected > 0 {
		put.ConditionExpression = aws.String("#r = :r")
		put.ExpressionAttributeNames = map[string]string{"#r": "revision"}
		put.ExpressionAttributeValues = map[string]dt.AttributeValue{":r": &dt.AttributeValueMemberN{Value: strconv.Itoa(expected)}}
	}
	_, err := s.d.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: []dt.TransactWriteItem{
		{ConditionCheck: &dt.ConditionCheck{TableName: table, Key: keys(parentOwner, parentKey), ConditionExpression: aws.String("#r = :r"), ExpressionAttributeNames: map[string]string{"#r": "revision"}, ExpressionAttributeValues: map[string]dt.AttributeValue{":r": &dt.AttributeValueMemberN{Value: strconv.Itoa(parentRevision)}}}},
		{Put: put},
	}})
	var cancelled *dt.TransactionCanceledException
	if errors.As(err, &cancelled) {
		for _, reason := range cancelled.CancellationReasons {
			if aws.ToString(reason.Code) == "ConditionalCheckFailed" {
				return errConflict
			}
		}
	}
	return err
}

func addPurgeTime(item map[string]dt.AttributeValue, data []byte) {
	var p Photo
	if json.Unmarshal(data, &p) == nil {
		if p.State == "trash" && p.ExpiresAt > 0 {
			item["purgeAt"] = &dt.AttributeValueMemberN{Value: strconv.FormatInt(p.ExpiresAt, 10)}
		} else if p.State == "shredded" {
			item["purgeAt"] = &dt.AttributeValueMemberN{Value: "0"}
		}
	}
}
func (s *awsRecords) MarkShredded(ctx context.Context, owner, key string, data []byte) error {
	_, err := s.d.UpdateItem(ctx, &dynamodb.UpdateItemInput{TableName: aws.String(os.Getenv("SESSIONS_TABLE")), Key: keys(owner, key), UpdateExpression: aws.String("SET #d = :d, purgeAt = :zero ADD #r :one"), ConditionExpression: aws.String("attribute_exists(pk)"), ExpressionAttributeNames: map[string]string{"#d": "data", "#r": "revision"}, ExpressionAttributeValues: map[string]dt.AttributeValue{":d": av(string(data)), ":zero": &dt.AttributeValueMemberN{Value: "0"}, ":one": &dt.AttributeValueMemberN{Value: "1"}}})
	var missing *dt.ConditionalCheckFailedException
	if errors.As(err, &missing) {
		return nil
	}
	return err
}
func (s *awsRecords) TrashCandidates(ctx context.Context, now int64) ([]trashRecord, error) {
	out := []trashRecord{}
	var start map[string]dt.AttributeValue
	for {
		v, err := s.d.Scan(ctx, &dynamodb.ScanInput{TableName: aws.String(os.Getenv("SESSIONS_TABLE")), Limit: aws.Int32(200), ExclusiveStartKey: start, FilterExpression: aws.String("purgeAt <= :now"), ExpressionAttributeValues: map[string]dt.AttributeValue{":now": &dt.AttributeValueMemberN{Value: strconv.FormatInt(now, 10)}}})
		if err != nil {
			return nil, err
		}
		for _, item := range v.Items {
			owner, ok := item["pk"].(*dt.AttributeValueMemberS)
			if !ok {
				continue
			}
			key, ok := item["sk"].(*dt.AttributeValueMemberS)
			if !ok {
				continue
			}
			data, ok := item["data"].(*dt.AttributeValueMemberS)
			if !ok {
				continue
			}
			var p Photo
			if json.Unmarshal([]byte(data.Value), &p) == nil {
				out = append(out, trashRecord{owner.Value, key.Value, p})
			}
		}
		if len(v.LastEvaluatedKey) == 0 || len(out) >= 20 {
			return out, nil
		}
		start = v.LastEvaluatedKey
	}
}

// Stream and bound original-byte verification; never load a full image into Lambda RAM.
func (s *awsRecords) ObjectSHA256(ctx context.Context, key string) (string, int64, error) {
	object, err := s.s.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(os.Getenv("PHOTOS_BUCKET")), Key: aws.String(key)})
	if err != nil {
		return "", 0, err
	}
	defer object.Body.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, io.LimitReader(object.Body, maxOriginalBytes+1))
	if err != nil {
		return "", size, err
	}
	if size > maxOriginalBytes {
		return "", size, errors.New("image too large")
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}

func (s *awsRecords) PutPhotoJob(ctx context.Context, user string, session Session, p Photo, expected int, job ClassificationJob) error {
	table := aws.String(os.Getenv("SESSIONS_TABLE"))
	owner := sessionOwner(user, session.ID)
	photoData, _ := json.Marshal(p)
	jobData, _ := json.Marshal(job)
	photo := keys(owner, "PHOTO#"+p.ID)
	photo["data"] = av(string(photoData))
	photo["revision"] = &dt.AttributeValueMemberN{Value: strconv.Itoa(p.Revision)}
	record := keys(owner, "JOB#"+job.ID)
	record["data"] = av(string(jobData))
	record["revision"] = &dt.AttributeValueMemberN{Value: strconv.Itoa(job.Revision)}
	addJobAttributes(record, jobData)
	_, err := s.d.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: []dt.TransactWriteItem{
		{ConditionCheck: &dt.ConditionCheck{TableName: table, Key: keys("USER#"+user, "SESSION#"+session.ID), ConditionExpression: aws.String("#r = :r"), ExpressionAttributeNames: map[string]string{"#r": "revision"}, ExpressionAttributeValues: map[string]dt.AttributeValue{":r": &dt.AttributeValueMemberN{Value: strconv.Itoa(sessionRevision(session))}}}},
		{Put: &dt.Put{TableName: table, Item: photo, ConditionExpression: aws.String("#r = :r"), ExpressionAttributeNames: map[string]string{"#r": "revision"}, ExpressionAttributeValues: map[string]dt.AttributeValue{":r": &dt.AttributeValueMemberN{Value: strconv.Itoa(expected)}}}},
		{Put: &dt.Put{TableName: table, Item: record, ConditionExpression: aws.String("attribute_not_exists(pk)")}},
	}})
	var conflict *dt.TransactionCanceledException
	if errors.As(err, &conflict) {
		for _, reason := range conflict.CancellationReasons {
			if aws.ToString(reason.Code) == "ConditionalCheckFailed" {
				return errConflict
			}
		}
	}
	return err
}
func addJobAttributes(item map[string]dt.AttributeValue, data []byte) {
	var job ClassificationJob
	if json.Unmarshal(data, &job) == nil && job.User != "" && job.SessionID != "" && job.PhotoID != "" {
		item["kind"] = av("classification-job")
		if job.WakeAt > 0 {
			item["jobPending"] = av("pending")
			item["jobWakeAt"] = &dt.AttributeValueMemberN{Value: strconv.FormatInt(job.WakeAt, 10)}
		}
	}
}
func (s *awsRecords) ObjectBytes(ctx context.Context, key string, max int64) ([]byte, error) {
	object, err := s.s.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(os.Getenv("PHOTOS_BUCKET")), Key: aws.String(key)})
	if err != nil {
		return nil, err
	}
	defer object.Body.Close()
	data, err := io.ReadAll(io.LimitReader(object.Body, max+1))
	if err == nil && int64(len(data)) > max {
		err = errors.New("object too large")
	}
	return data, err
}
func (s *awsRecords) PendingJobs(ctx context.Context, now int64) ([]ClassificationJob, error) {
	page, err := s.d.Query(ctx, &dynamodb.QueryInput{TableName: aws.String(os.Getenv("SESSIONS_TABLE")), IndexName: aws.String("classification-wake"), Limit: aws.Int32(20), KeyConditionExpression: aws.String("jobPending = :pending AND jobWakeAt <= :now"), ExpressionAttributeValues: map[string]dt.AttributeValue{":pending": av("pending"), ":now": &dt.AttributeValueMemberN{Value: strconv.FormatInt(now, 10)}}})
	if err != nil {
		return nil, err
	}
	out := []ClassificationJob{}
	for _, item := range page.Items {
		if data, ok := item["data"].(*dt.AttributeValueMemberS); ok {
			var job ClassificationJob
			if json.Unmarshal([]byte(data.Value), &job) == nil {
				out = append(out, job)
			}
		}
	}
	return out, nil
}
