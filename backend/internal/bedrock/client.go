// Package bedrock implements the documented Mantle OpenAI route using AWS SigV4.
package bedrock

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/config"
	"io"
	"net/http"
	"time"
)

const Model = "google.gemma-4-e2b"
const Service = "bedrock-mantle"

var ErrCredentials = errors.New("AWS credentials unavailable")

func ValidRegion(region string) bool {
	switch region {
	case "us-east-1", "us-east-2", "us-west-2", "eu-central-1":
		return true
	}
	return false
}

type Client struct {
	Region      string
	credentials aws.CredentialsProvider
	http        *http.Client
	endpoint    string
	backoff     time.Duration
}

func New(ctx context.Context, region string) (*Client, error) {
	if !ValidRegion(region) {
		return nil, fmt.Errorf("Gemma 4 E2B is not configured for region %s", region)
	}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, ErrCredentials
	}
	return &Client{Region: region, credentials: cfg.Credentials, http: &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, endpoint: "https://bedrock-mantle." + region + ".api.aws", backoff: 250 * time.Millisecond}, nil
}
func (c *Client) Send(ctx context.Context, method, path string, data []byte) (*http.Response, error) {
	for attempt := 1; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Content-Type", "application/json")
		credentials, err := c.credentials.Retrieve(ctx)
		if err != nil {
			return nil, ErrCredentials
		}
		hash := sha256.Sum256(data)
		if err := v4.NewSigner().SignHTTP(ctx, credentials, request, hex.EncodeToString(hash[:]), Service, c.Region, time.Now().UTC()); err != nil {
			return nil, ErrCredentials
		}
		response, err := c.http.Do(request)
		if err != nil {
			return nil, err
		}
		transient := response.StatusCode == 500 || response.StatusCode == 502 || response.StatusCode == 503 || response.StatusCode == 504
		if !transient || attempt == 3 {
			return response, nil
		}
		response.Body.Close()
		timer := time.NewTimer(c.backoff * time.Duration(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
func (c *Client) CheckModel(ctx context.Context) error {
	response, err := c.Send(ctx, "GET", "/v1/models/"+Model, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("Bedrock model metadata returned HTTP %d; verify model access and bedrock-mantle:GetModel permission in %s", response.StatusCode, c.Region)
	}
	var result struct {
		ID string `json:"id"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil || result.ID != Model {
		return errors.New("Bedrock did not advertise the requested Gemma 4 E2B model")
	}
	return nil
}
func Invoke(ctx context.Context, region string, data []byte) (*http.Response, error) {
	client, err := New(ctx, region)
	if err != nil {
		return nil, err
	}
	return client.Send(ctx, "POST", "/openai/v1/chat/completions", data)
}
