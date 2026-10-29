package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/aws/aws-lambda-go/events"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var accountHTTP = &http.Client{Timeout: 8 * time.Second}

func accountsEnabled() bool {
	return os.Getenv("COGNITO_CLIENT_ID") != "" && os.Getenv("COGNITO_POOL_ID") != ""
}
func accountConfig() events.APIGatewayV2HTTPResponse {
	return apiJSON(200, map[string]any{"enabled": accountsEnabled(), "clientId": os.Getenv("COGNITO_CLIENT_ID"), "region": os.Getenv("AWS_REGION")})
}

var accountOwner = verifyAccountOwner

func verifyAccountOwner(ctx context.Context, req events.APIGatewayV2HTTPRequest) (string, error) {
	auth := req.Headers["authorization"]
	if auth == "" {
		auth = req.Headers["Authorization"]
	}
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", errors.New("authentication required")
	}
	token := strings.TrimPrefix(auth, "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 16384 {
		return "", errors.New("invalid token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	// Claims are only a prefilter: GetUser validates the token with Cognito.
	var claims struct {
		Iss    string `json:"iss"`
		Client string `json:"client_id"`
		Use    string `json:"token_use"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Use != "access" || claims.Client != os.Getenv("COGNITO_CLIENT_ID") || claims.Iss != "https://cognito-idp."+os.Getenv("AWS_REGION")+".amazonaws.com/"+os.Getenv("COGNITO_POOL_ID") {
		return "", errors.New("wrong pool")
	}
	data, _ := json.Marshal(map[string]string{"AccessToken": token})
	request, err := http.NewRequestWithContext(ctx, "POST", "https://cognito-idp."+os.Getenv("AWS_REGION")+".amazonaws.com/", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-amz-json-1.1")
	request.Header.Set("X-Amz-Target", "AWSCognitoIdentityProviderService.GetUser")
	response, err := accountHTTP.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", errors.New("invalid login")
	}
	var user struct {
		Attributes []struct{ Name, Value string } `json:"UserAttributes"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&user) != nil {
		return "", errors.New("invalid user")
	}
	for _, a := range user.Attributes {
		if a.Name == "sub" && a.Value != "" && len(a.Value) < 128 {
			return a.Value, nil
		}
	}
	return "", errors.New("missing identity")
}
