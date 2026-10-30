package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-lambda-go/events"
	"strings"
	"time"
	"unicode/utf8"
)

const defaultCategoryPrompt = `Classify this image into exactly one category: Indoors, Outdoors, Documents, Computer screens. Computer interfaces and monitors are Computer screens; pages, receipts and forms are Documents. Otherwise choose Indoors or Outdoors. Return only JSON: {"category":"one of these categories","description":"one sentence, as short as possible, at most 180 characters"}.`

type ClassificationJob struct {
	Consent    bool   `json:"consent"`
	ID         string `json:"id"`
	User       string `json:"user"`
	SessionID  string `json:"sessionId"`
	PhotoID    string `json:"photoId"`
	Prompt     string `json:"prompt"`
	State      string `json:"state"`
	Attempts   int    `json:"attempts"`
	Revision   int    `json:"revision"`
	WakeAt     int64  `json:"wakeAt"`
	LeaseUntil int64  `json:"leaseUntil"`
}
type classificationFailure struct {
	Message string
	Retry   bool
}

func (e *classificationFailure) Error() string { return e.Message }
func validJobPrompt(prompt string) bool {
	return strings.TrimSpace(prompt) != "" && utf8.RuneCountInString(prompt) <= 1000
}
func enqueuePhoto(ctx context.Context, store recordStore, user string, session Session, p *Photo, expected int, prompt string, consent bool) (ClassificationJob, error) {
	if !consent || !validJobPrompt(prompt) {
		return ClassificationJob{}, errors.New("Confirm AWS consent and enter a prompt of 1–1000 characters")
	}
	if p.State == "trash" || p.State == "shredded" || p.State == "uploading" {
		return ClassificationJob{}, errors.New("Photo is not ready for categorization")
	}
	job := ClassificationJob{Consent: true, ID: newID(), User: user, SessionID: session.ID, PhotoID: p.ID, Prompt: prompt, State: "queued", Revision: 1, WakeAt: time.Now().Add(2 * time.Minute).Unix()}
	next := *p
	sum := sha256.Sum256([]byte(prompt))
	next.PromptHash = hex.EncodeToString(sum[:])
	next.InferenceModel = cloudModel
	next.JobID = job.ID
	next.InferencePrompt = prompt
	next.CloudConsent = true
	next.State = "pending"
	next.ProcessingError = ""
	next.ProcessingAttempts = 0
	next.Conflict = false
	next.Revision = expected + 1
	next.UserRevision = next.Revision
	next.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	if err := store.PutPhotoJob(ctx, user, session, next, expected, job); err != nil {
		return ClassificationJob{}, err
	}
	*p = next
	return job, nil
}

var inferStoredPhoto = func(ctx context.Context, store recordStore, job ClassificationJob) (string, error) {
	image, err := store.ObjectBytes(ctx, photoKey(job.User, job.SessionID, job.PhotoID, "prepared.jpg"), 512<<10)
	if err != nil {
		return "", &classificationFailure{Message: "Could not read the prepared photo. Retry later.", Retry: true}
	}
	body, _ := json.Marshal(map[string]any{"image": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(image), "prompt": job.Prompt, "consent": true})
	req := events.APIGatewayV2HTTPRequest{RawPath: "/api/classify", Body: string(body)}
	req.RequestContext.HTTP.Method = "POST"
	response := cloudRoute(ctx, req)
	if response.StatusCode != 200 {
		var failure struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		json.Unmarshal([]byte(response.Body), &failure)
		retry := response.StatusCode == 429 || response.StatusCode >= 500
		switch failure.Code {
		case "PROVIDER_ACCESS_DENIED", "MODEL_UNAVAILABLE", "OUTPUT_BLOCKED":
			retry = false
		}
		return "", &classificationFailure{Message: failure.Error, Retry: retry}
	}
	var answer struct {
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(response.Body), &answer) != nil {
		return "", &classificationFailure{Message: "Invalid inference response.", Retry: true}
	}
	return answer.Text, nil
}

func classificationResult(text string) (string, string) {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		text = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(text, "```json"), "```"))
		text = strings.TrimSpace(strings.TrimSuffix(text, "```"))
	}
	var value struct {
		Category    string `json:"category"`
		Description string `json:"description"`
	}
	if json.Unmarshal([]byte(text), &value) != nil || strings.TrimSpace(value.Description) == "" {
		return "", ""
	}
	switch value.Category {
	case "Indoors", "Outdoors", "Documents", "Computer screens":
	default:
		return "", ""
	}
	description := []rune(strings.TrimSpace(value.Description))
	if len(description) > 180 {
		description = description[:180]
	}
	return value.Category, string(description)
}
func readJobPhoto(ctx context.Context, store recordStore, job ClassificationJob) (Session, Photo, error) {
	var session Session
	var p Photo
	data, err := store.Get(ctx, "USER#"+job.User, "SESSION#"+job.SessionID)
	if err != nil {
		return session, p, err
	}
	if data == nil {
		return session, p, nil
	}
	if json.Unmarshal(data, &session) != nil {
		return session, p, errors.New("invalid session")
	}
	if session.Deleting {
		return session, p, nil
	}
	data, err = store.Get(ctx, sessionOwner(job.User, job.SessionID), "PHOTO#"+job.PhotoID)
	if err != nil || data == nil {
		return session, p, err
	}
	err = json.Unmarshal(data, &p)
	return session, p, err
}
func finishClassificationJob(ctx context.Context, store recordStore, job *ClassificationJob, state string) error {
	expected := job.Revision
	job.Revision++
	job.State = state
	job.WakeAt = 0
	job.LeaseUntil = 0
	data, _ := json.Marshal(job)
	return store.Put(ctx, sessionOwner(job.User, job.SessionID), "JOB#"+job.ID, data, job.Revision, expected)
}
func processClassification(ctx context.Context, store recordStore, message ClassificationJob) error {
	if !resourceID.MatchString(message.ID) || !resourceID.MatchString(message.SessionID) || message.User == "" || strings.ContainsAny(message.User, "/#") {
		return errors.New("invalid job reference")
	}
	owner := sessionOwner(message.User, message.SessionID)
	data, err := store.Get(ctx, owner, "JOB#"+message.ID)
	if err != nil || data == nil {
		return err
	}
	var job ClassificationJob
	if json.Unmarshal(data, &job) != nil {
		return errors.New("invalid job")
	}
	if job.ID != message.ID || job.User != message.User || job.SessionID != message.SessionID {
		return errors.New("job identity mismatch")
	}
	if job.State == "done" || job.State == "error" || job.State == "cancelled" {
		return nil
	}
	if job.State == "processing" && job.LeaseUntil > time.Now().Unix() {
		return errors.New("job already processing")
	}
	session, p, err := readJobPhoto(ctx, store, job)
	if err != nil {
		return err
	}
	if p.ID == "" || p.JobID != job.ID || !p.CloudConsent || p.State == "trash" || p.State == "shredded" || p.State == "done" || p.State == "review" {
		return finishClassificationJob(ctx, store, &job, "cancelled")
	}
	if job.Attempts >= 3 {
		expected := p.Revision
		p.State = "error"
		p.ProcessingError = "Cloud processing could not finish. Retry this photo."
		p.Revision++
		if err := saveSessionPhoto(ctx, store, job.User, session, p, expected); err != nil {
			return err
		}
		return finishClassificationJob(ctx, store, &job, "error")
	}
	expected := job.Revision
	job.Revision++
	job.State = "processing"
	job.Attempts++
	job.LeaseUntil = time.Now().Add(90 * time.Second).Unix()
	job.WakeAt = job.LeaseUntil + 120
	encoded, _ := json.Marshal(job)
	if err := store.Put(ctx, owner, "JOB#"+job.ID, encoded, job.Revision, expected); err != nil {
		return err
	}
	expected = p.Revision
	p.State = "processing"
	p.ProcessingAttempts = job.Attempts
	p.ProcessingError = ""
	p.Revision++
	p.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	if err := saveSessionPhoto(ctx, store, job.User, session, p, expected); err != nil {
		return err
	}
	var text string
	var inferenceErr error
	if !job.Consent {
		inferenceErr = &classificationFailure{Message: "Recorded AWS consent is required. Retry after confirming consent.", Retry: false}
	} else {
		text, inferenceErr = inferStoredPhoto(ctx, store, job)
	}
	// Re-read after inference. Never overwrite a newer job, manual category or Trash.
	session, live, err := readJobPhoto(ctx, store, job)
	if err != nil {
		return err
	}
	if live.ID == "" || live.JobID != job.ID || !live.CloudConsent || (live.State != "pending" && live.State != "processing") {
		return finishClassificationJob(ctx, store, &job, "cancelled")
	}
	expected = live.Revision
	live.Revision++
	live.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	live.ProcessingAttempts = job.Attempts
	if inferenceErr != nil {
		var failure *classificationFailure
		retry := errors.As(inferenceErr, &failure) && failure.Retry && job.Attempts < 3
		live.ProcessingError = "Cloud categorization failed. Retry this photo."
		if failure != nil && failure.Message != "" {
			live.ProcessingError = failure.Message
		}
		live.State = "error"
		if retry {
			live.State = "pending"
		}
		if err := saveSessionPhoto(ctx, store, job.User, session, live, expected); err != nil {
			return err
		}
		if !retry {
			return finishClassificationJob(ctx, store, &job, "error")
		}
		expected = job.Revision
		job.Revision++
		job.State = "queued"
		job.LeaseUntil = 0
		job.WakeAt = time.Now().Add(6 * time.Minute).Unix()
		encoded, _ = json.Marshal(job)
		if err := store.Put(ctx, owner, "JOB#"+job.ID, encoded, job.Revision, expected); err != nil {
			return err
		}
		return fmt.Errorf("transient inference failure: retry queued")
	}
	live.Category, live.Description = classificationResult(text)
	live.State = "done"
	live.ProcessingError = ""
	if live.Category == "" {
		live.State = "review"
		live.ProcessingError = "The model did not return valid category JSON. Review or retry this photo."
	}
	if len(text) > 8192 {
		text = text[:8192]
	}
	live.RawOutput = text
	if err := saveSessionPhoto(ctx, store, job.User, session, live, expected); err != nil {
		return err
	}
	return finishClassificationJob(ctx, store, &job, "done")
}

func reclassifyPhoto(ctx context.Context, store recordStore, user string, session Session, id string, body []byte) events.APIGatewayV2HTTPResponse {
	var request struct {
		Revision int    `json:"revision"`
		Prompt   string `json:"prompt"`
		Consent  bool   `json:"consent"`
	}
	if json.Unmarshal(body, &request) != nil || !request.Consent || !validJobPrompt(request.Prompt) {
		return cloudError(400, "Confirm AWS consent and enter a prompt of 1–1000 characters.")
	}
	data, err := store.Get(ctx, sessionOwner(user, session.ID), "PHOTO#"+id)
	if err != nil {
		return storeError(err)
	}
	if data == nil {
		return cloudError(404, "Photo not found.")
	}
	var p Photo
	if json.Unmarshal(data, &p) != nil {
		return storeError(errors.New("invalid photo"))
	}
	if p.State == "trash" || p.State == "shredded" || p.State == "uploading" {
		return cloudError(409, "Restore or finish uploading this photo first.")
	}
	if request.Revision != p.Revision {
		return storeError(errConflict)
	}
	if p.JobID != "" && (p.State == "pending" || p.State == "processing") {
		return apiJSON(200, p)
	}
	if _, err := enqueuePhoto(ctx, store, user, session, &p, p.Revision, request.Prompt, true); err != nil {
		return storeError(err)
	}
	return apiJSON(202, p)
}

func queuePendingPhotos(ctx context.Context, store recordStore, user string, session Session, body []byte) events.APIGatewayV2HTTPResponse {
	var request struct {
		Prompt  string `json:"prompt"`
		Consent bool   `json:"consent"`
	}
	if json.Unmarshal(body, &request) != nil || !request.Consent || !validJobPrompt(request.Prompt) {
		return cloudError(400, "Confirm AWS consent and enter a prompt of 1–1000 characters.")
	}
	records, err := store.List(ctx, sessionOwner(user, session.ID), "PHOTO#")
	if err != nil {
		return storeError(err)
	}
	queued := []Photo{}
	remaining := false
	for _, data := range records {
		var p Photo
		if json.Unmarshal(data, &p) != nil || p.State != "pending" || p.JobID != "" || p.Conflict {
			continue
		}
		if len(queued) >= 20 {
			remaining = true
			break
		}
		if _, err := enqueuePhoto(ctx, store, user, session, &p, p.Revision, request.Prompt, true); err != nil {
			if errors.Is(err, errConflict) {
				continue
			}
			return storeError(err)
		}
		queued = append(queued, p)
	}
	return apiJSON(200, map[string]any{"photos": queued, "remaining": remaining})
}
