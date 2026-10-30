package main

import (
	"context"
	"encoding/json"
	"github.com/aws/aws-lambda-go/events"
	"strings"
	"testing"
	"time"
)

func TestBackgroundJobLifecycle(t *testing.T) {
	ctx := context.Background()
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	session := Session{ID: newID(), Revision: 1}
	if err := saveRecord(ctx, m, "USER#alice", "SESSION#"+session.ID, session, 1, 0); err != nil {
		t.Fatal(err)
	}
	p := Photo{ID: newID(), Revision: 1, State: "pending", InferencePrompt: defaultCategoryPrompt, CloudConsent: true}
	if err := saveSessionPhoto(ctx, m, "alice", session, p, 0); err != nil {
		t.Fatal(err)
	}
	job, err := enqueuePhoto(ctx, m, "alice", session, &p, p.Revision, defaultCategoryPrompt, true)
	if err != nil {
		t.Fatal(err)
	}
	encodedPhoto, _ := json.Marshal(p)
	var metadata map[string]any
	json.Unmarshal(encodedPhoto, &metadata)
	if metadata["userRevision"] != float64(p.Revision) {
		t.Fatal("enqueue must mark user revision", metadata)
	}
	queuedUserRevision := p.Revision
	oldInfer := inferStoredPhoto
	defer func() { inferStoredPhoto = oldInfer }()
	calls := 0
	inferStoredPhoto = func(context.Context, recordStore, ClassificationJob) (string, error) {
		calls++
		return `{"category":"Indoors","description":"A room."}`, nil
	}
	if err := processClassification(ctx, m, job); err != nil {
		t.Fatal(err)
	}
	if err := processClassification(ctx, m, job); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("duplicate delivery invoked the provider", calls)
	}
	data, _ := m.Get(ctx, sessionOwner("alice", session.ID), "PHOTO#"+p.ID)
	json.Unmarshal(data, &p)
	if p.State != "done" || p.Description != "A room." {
		t.Fatal(p)
	}
	encodedPhoto, _ = json.Marshal(p)
	json.Unmarshal(encodedPhoto, &metadata)
	if metadata["userRevision"] != float64(queuedUserRevision) {
		t.Fatal("automatic result changed the user revision", metadata)
	}
	// A newer manual change wins over an in-flight result.
	next, err := enqueuePhoto(ctx, m, "alice", session, &p, p.Revision, defaultCategoryPrompt, true)
	if err != nil {
		t.Fatal(err)
	}
	inferStoredPhoto = func(context.Context, recordStore, ClassificationJob) (string, error) {
		data, _ := m.Get(ctx, sessionOwner("alice", session.ID), "PHOTO#"+p.ID)
		var live Photo
		json.Unmarshal(data, &live)
		expected := live.Revision
		live.State = "trash"
		live.Revision++
		if err := saveSessionPhoto(ctx, m, "alice", session, live, expected); err != nil {
			t.Fatal(err)
		}
		return `{"category":"Outdoors","description":"A tree."}`, nil
	}
	if err := processClassification(ctx, m, next); err != nil {
		t.Fatal(err)
	}
	data, _ = m.Get(ctx, sessionOwner("alice", session.ID), "PHOTO#"+p.ID)
	json.Unmarshal(data, &p)
	if p.State != "trash" {
		t.Fatal("late result restored Trash", p)
	}
}
func TestBackgroundRetryAndConsent(t *testing.T) {
	ctx := context.Background()
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	s := Session{ID: newID(), Revision: 1}
	saveRecord(ctx, m, "USER#alice", "SESSION#"+s.ID, s, 1, 0)
	p := Photo{ID: newID(), Revision: 1, State: "pending"}
	saveSessionPhoto(ctx, m, "alice", s, p, 0)
	if _, err := enqueuePhoto(ctx, m, "alice", s, &p, 1, defaultCategoryPrompt, false); err == nil {
		t.Fatal("queued without consent")
	}
	job, err := enqueuePhoto(ctx, m, "alice", s, &p, 1, defaultCategoryPrompt, true)
	if err != nil {
		t.Fatal(err)
	}
	old := inferStoredPhoto
	defer func() { inferStoredPhoto = old }()
	inferStoredPhoto = func(context.Context, recordStore, ClassificationJob) (string, error) {
		return "", &classificationFailure{Message: "Temporary provider failure", Retry: true}
	}
	for attempt := 0; attempt < 3; attempt++ {
		err = processClassification(ctx, m, job)
		if attempt < 2 && err == nil {
			t.Fatal("transient failure was acknowledged")
		}
	}
	data, _ := m.Get(ctx, sessionOwner("alice", s.ID), "PHOTO#"+p.ID)
	json.Unmarshal(data, &p)
	if p.State != "error" || !strings.Contains(p.ProcessingError, "Temporary") {
		t.Fatal(p)
	}
	if _, err := enqueuePhoto(ctx, m, "alice", s, &p, p.Revision, "", true); err == nil {
		t.Fatal("empty prompt accepted")
	}
}

func TestDispatchAndRecovery(t *testing.T) {
	ctx := context.Background()
	job := ClassificationJob{ID: newID(), User: "alice", SessionID: newID(), PhotoID: newID(), State: "queued", Revision: 1, WakeAt: 1}
	oldSend := sendClassificationJob
	defer func() { sendClassificationJob = oldSend }()
	sent := 0
	sendClassificationJob = func(context.Context, ClassificationJob) error { sent++; return nil }
	data, _ := json.Marshal(job)
	record := events.DynamoDBEventRecord{EventName: "INSERT", Change: events.DynamoDBStreamRecord{NewImage: map[string]events.DynamoDBAttributeValue{"kind": events.NewStringAttribute("classification-job"), "data": events.NewStringAttribute(string(data))}}}
	if err := dispatchClassification(ctx, events.DynamoDBEvent{Records: []events.DynamoDBEventRecord{record}}); err != nil {
		t.Fatal(err)
	}
	record.EventName = "MODIFY"
	dispatchClassification(ctx, events.DynamoDBEvent{Records: []events.DynamoDBEventRecord{record}})
	if sent != 1 {
		t.Fatal("job updates must not enqueue another message", sent)
	}
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	m.Put(ctx, sessionOwner("alice", job.SessionID), "JOB#"+job.ID, data, 1, 0)
	if err := recoverClassificationJobs(ctx, m); err != nil {
		t.Fatal(err)
	}
	if sent != 2 {
		t.Fatal("durable job was not recovered")
	}
}
func TestAutomaticUploadCreatesJob(t *testing.T) {
	t.Setenv("COGNITO_CLIENT_ID", "client")
	t.Setenv("COGNITO_POOL_ID", "pool")
	ctx := context.Background()
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	oldOwner, oldFactory, oldInfer := accountOwner, storeFactory, inferStoredPhoto
	defer func() { accountOwner = oldOwner; storeFactory = oldFactory; inferStoredPhoto = oldInfer }()
	accountOwner = func(context.Context, events.APIGatewayV2HTTPRequest) (string, error) { return "alice", nil }
	storeFactory = func(context.Context) (recordStore, error) { return m, nil }
	s := Session{ID: newID(), Revision: 1}
	saveRecord(ctx, m, "USER#alice", "SESSION#"+s.ID, s, 1, 0)
	call := func(method, path string, value any) events.APIGatewayV2HTTPResponse {
		data, _ := json.Marshal(value)
		req := events.APIGatewayV2HTTPRequest{RawPath: "/api/sessions/" + s.ID + path, Body: string(data)}
		req.RequestContext.HTTP.Method = method
		return sessionRoute(ctx, req)
	}
	response := call("POST", "/photos", Photo{Mime: "image/jpeg", Bytes: 100, CloudConsent: true, InferencePrompt: defaultCategoryPrompt})
	var uploaded struct {
		Photo Photo `json:"photo"`
	}
	json.Unmarshal([]byte(response.Body), &uploaded)
	if response.StatusCode != 201 {
		t.Fatal(response)
	}
	p := uploaded.Photo
	m.sizes[photoKey("alice", s.ID, p.ID, "original")] = 100
	m.sizes[photoKey("alice", s.ID, p.ID, "prepared.jpg")] = 40
	response = call("PATCH", "/photos/"+p.ID, Photo{State: "pending", Revision: 1})
	if response.StatusCode != 200 {
		t.Fatal(response)
	}
	json.Unmarshal([]byte(response.Body), &p)
	if p.JobID == "" || p.PromptHash == "" {
		t.Fatal("upload completion did not queue categorization", p)
	}
	jobs, _ := m.List(ctx, sessionOwner("alice", s.ID), "JOB#")
	if len(jobs) != 1 {
		t.Fatal("photo/job handoff missing")
	}
	response = call("POST", "/photos/"+p.ID+"/classify", map[string]any{"revision": p.Revision, "consent": true, "prompt": defaultCategoryPrompt})
	if response.StatusCode != 200 {
		t.Fatal(response)
	}
	jobs, _ = m.List(ctx, sessionOwner("alice", s.ID), "JOB#")
	if len(jobs) != 1 {
		t.Fatal("active job was duplicated")
	}
	inferStoredPhoto = func(context.Context, recordStore, ClassificationJob) (string, error) {
		return `{"category":"Documents","description":"A page."}`, nil
	}
	var job ClassificationJob
	json.Unmarshal(jobs[0], &job)
	if err := processClassification(ctx, m, job); err != nil {
		t.Fatal(err)
	}
	data, _ := m.Get(ctx, sessionOwner("alice", s.ID), "PHOTO#"+p.ID)
	json.Unmarshal(data, &p)
	response = call("POST", "/photos/"+p.ID+"/classify", map[string]any{"revision": p.Revision, "consent": false, "prompt": defaultCategoryPrompt})
	if response.StatusCode != 400 {
		t.Fatal("reclassification ignored consent", response)
	}
	response = call("POST", "/photos/"+p.ID+"/classify", map[string]any{"revision": p.Revision, "consent": true, "prompt": "Return short category JSON in Spanish."})
	if response.StatusCode != 202 {
		t.Fatal(response)
	}
	jobs, _ = m.List(ctx, sessionOwner("alice", s.ID), "JOB#")
	if len(jobs) != 2 {
		t.Fatal("explicit reclassification did not create a new job")
	}
	json.Unmarshal([]byte(response.Body), &p)
	queuedID := p.JobID
	response = call("PATCH", "/photos/"+p.ID, Photo{State: "error", Revision: p.Revision})
	var restored Photo
	json.Unmarshal([]byte(response.Body), &restored)
	if response.StatusCode != 200 || restored.JobID != "" || restored.UserRevision != restored.Revision {
		t.Fatal("manual Undo did not fence the queued job", response)
	}
	inferStoredPhoto = func(context.Context, recordStore, ClassificationJob) (string, error) {
		t.Fatal("cancelled job invoked the provider")
		return "", nil
	}
	for _, data := range jobs {
		var oldJob ClassificationJob
		json.Unmarshal(data, &oldJob)
		if oldJob.ID == queuedID {
			if err := processClassification(ctx, m, oldJob); err != nil {
				t.Fatal(err)
			}
		}
	}
}
func TestFailedAtomicJobDoesNotMutatePhoto(t *testing.T) {
	ctx := context.Background()
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	s := Session{ID: newID(), Revision: 1}
	saveRecord(ctx, m, "USER#alice", "SESSION#"+s.ID, s, 1, 0)
	p := Photo{ID: newID(), Revision: 1, State: "pending"}
	saveSessionPhoto(ctx, m, "alice", s, p, 0)
	if _, err := enqueuePhoto(ctx, m, "alice", s, &p, 99, defaultCategoryPrompt, true); err == nil {
		t.Fatal("stale revision accepted")
	}
	if p.JobID != "" {
		t.Fatal("failed transaction mutated the local photo")
	}
	jobs, _ := m.List(ctx, sessionOwner("alice", s.ID), "JOB#")
	if len(jobs) != 0 {
		t.Fatal("partial job created")
	}
}

func TestWorkerLeaseAndMalformedOutput(t *testing.T) {
	ctx := context.Background()
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	s := Session{ID: newID(), Revision: 1}
	saveRecord(ctx, m, "USER#alice", "SESSION#"+s.ID, s, 1, 0)
	p := Photo{ID: newID(), Revision: 1, State: "pending"}
	saveSessionPhoto(ctx, m, "alice", s, p, 0)
	job, err := enqueuePhoto(ctx, m, "alice", s, &p, 1, defaultCategoryPrompt, true)
	if err != nil {
		t.Fatal(err)
	}
	old := inferStoredPhoto
	defer func() { inferStoredPhoto = old }()
	calls := 0
	inferStoredPhoto = func(context.Context, recordStore, ClassificationJob) (string, error) { calls++; return "Indoors", nil }
	job.State = "processing"
	job.Attempts = 1
	job.LeaseUntil = time.Now().Add(time.Minute).Unix()
	job.Revision++
	data, _ := json.Marshal(job)
	m.Put(ctx, sessionOwner("alice", s.ID), "JOB#"+job.ID, data, job.Revision, job.Revision-1)
	if err := processClassification(ctx, m, job); err == nil {
		t.Fatal("unexpired lease was ignored")
	}
	if calls != 0 {
		t.Fatal("concurrent job called model")
	}
	job.LeaseUntil = 1
	job.Revision++
	data, _ = json.Marshal(job)
	m.Put(ctx, sessionOwner("alice", s.ID), "JOB#"+job.ID, data, job.Revision, job.Revision-1)
	if err := processClassification(ctx, m, job); err != nil {
		t.Fatal(err)
	}
	data, _ = m.Get(ctx, sessionOwner("alice", s.ID), "PHOTO#"+p.ID)
	json.Unmarshal(data, &p)
	if calls != 1 || p.State != "review" || p.RawOutput != "Indoors" {
		t.Fatal("expired lease or invalid JSON handling", calls, p)
	}
}
func TestQueueReportsOnlyFailedMessages(t *testing.T) {
	old := storeFactory
	defer func() { storeFactory = old }()
	m := &memoryRecords{map[string][]byte{}, map[string]int{}, map[string]int64{}}
	storeFactory = func(context.Context) (recordStore, error) { return m, nil }
	message, _ := json.Marshal(ClassificationJob{ID: newID(), User: "alice", SessionID: newID()})
	event, _ := json.Marshal(events.SQSEvent{Records: []events.SQSMessage{{MessageId: "bad", EventSource: "aws:sqs", Body: "{"}, {MessageId: "already-removed", EventSource: "aws:sqs", Body: string(message)}}})
	response, err := backgroundHandler(context.Background(), event)
	if err != nil {
		t.Fatal(err)
	}
	failed := response.(events.SQSEventResponse).BatchItemFailures
	if len(failed) != 1 || failed[0].ItemIdentifier != "bad" {
		t.Fatal(failed)
	}
}
