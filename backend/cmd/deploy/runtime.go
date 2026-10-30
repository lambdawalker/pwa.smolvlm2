package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Only public resource identifiers are cached. Credentials remain in the AWS provider chain.
func saveLocalRuntime(root, region string, outputs []byte) error {
	var values map[string]any
	if err := json.Unmarshal(outputs, &values); err != nil {
		return err
	}
	runtime := map[string]string{"AWS_REGION": region}
	for output, env := range map[string]string{"userPoolId": "COGNITO_POOL_ID", "userPoolClientId": "COGNITO_CLIENT_ID", "sessionsTable": "SESSIONS_TABLE", "photosBucket": "PHOTOS_BUCKET", "classificationQueueUrl": "CLASSIFICATION_QUEUE_URL"} {
		if value, ok := values[output].(string); ok && value != "" {
			runtime[env] = value
		}
	}
	data, err := json.MarshalIndent(runtime, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, ".deploy", "runtime.json"), data, 0600)
}
