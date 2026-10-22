package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

const gemmaModel = "gemma-4-26b-a4b-it"

// GET metadata verifies credentials/model availability without sending photos or generating tokens.
func checkGemmaAccess(client *http.Client, endpoint, key string) error {
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return fmt.Errorf("cannot prepare Google access check")
	}
	req.Header.Set("x-goog-api-key", key)
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach Google; check your connection and retry")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("Google model access check returned HTTP %d; check GEMINI_API_KEY and access to %s in Google AI Studio", response.StatusCode, gemmaModel)
	}
	var model struct {
		SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&model) != nil {
		return fmt.Errorf("invalid Google model response")
	}
	for _, method := range model.SupportedGenerationMethods {
		if method == "generateContent" {
			return nil
		}
	}
	return fmt.Errorf("Google does not advertise generateContent for %s", gemmaModel)
}
func setupGemma(infra string) error {
	fmt.Println("Cloud Gemma: free-tier quota applies; selected photos go to Google. Google may use free-tier content to improve its products.")
	key := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if key == "" {
		key = configValue(infra, "geminiApiKey", "")
	}
	if key == "" {
		fmt.Println("Create a Google AI Studio API key: https://aistudio.google.com/apikey")
		fmt.Print("Gemini API key for hosted Gemma (hidden; Enter skips cloud setup): ")
		value, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return fmt.Errorf("cannot read hidden key; set GEMINI_API_KEY locally and rerun")
		}
		key = strings.TrimSpace(string(value))
		if key == "" {
			fmt.Println("Cloud Gemma disabled; on-device models remain available.")
			return nil
		}
	} else {
		fmt.Println("Reusing Gemini API key (hidden).")
	}
	if err := checkGemmaAccess(&http.Client{Timeout: 20 * time.Second}, "https://generativelanguage.googleapis.com/v1beta/models/"+gemmaModel, key); err != nil {
		return err
	}
	if err := setSecret(infra, "geminiApiKey", key); err != nil {
		return err
	}
	fmt.Println("Hosted Gemma access verified; API key saved as a KMS-encrypted Pulumi secret.")
	return nil
}
