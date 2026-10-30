// Interactive deployment orchestration. Infrastructure remains in ../infra.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"golang.org/x/term"
)

var input = bufio.NewReader(os.Stdin)

func main() {
	if err := wizard(); err != nil {
		fmt.Fprintln(os.Stderr, "\nDeployment stopped:", err)
		os.Exit(1)
	}
}
func ask(label, fallback string) (string, error) {
	fmt.Printf("%s [%s]: ", label, fallback)
	line, err := input.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("interactive input required: %w", err)
	}
	line = strings.TrimSpace(line)
	if line == "" {
		line = fallback
	}
	return line, nil
}
func command(dir, name string, args ...string) *exec.Cmd {
	// npm is a batch launcher on Windows. Only fixed npm arguments are passed here.
	if runtime.GOOS == "windows" && name == "npm" {
		args = append([]string{"/d", "/c", "npm"}, args...)
		name = "cmd.exe"
	}
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	return cmd
}
func run(dir, name string, args ...string) error {
	cmd := command(dir, name, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	return nil
}
func output(dir, name string, args ...string) ([]byte, error) {
	cmd := command(dir, name, args...)
	cmd.Stderr = os.Stderr
	return cmd.Output()
}
func configValue(dir, key, fallback string) string {
	cmd := command(dir, "pulumi", "config", "get", key)
	b, err := cmd.Output()
	if err == nil && strings.TrimSpace(string(b)) != "" {
		return strings.TrimSpace(string(b))
	}
	return fallback
}
func cfGet(token, path string, target any) error {
	req, err := http.NewRequest("GET", "https://api.cloudflare.com/client/v4"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("Cloudflare connection failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("Cloudflare HTTP %d; check the token and zone permissions", response.StatusCode)
	}
	var envelope struct {
		Success bool            `json:"success"`
		Result  json.RawMessage `json:"result"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&envelope); err != nil {
		return err
	}
	if !envelope.Success {
		return fmt.Errorf("Cloudflare rejected the request")
	}
	return json.Unmarshal(envelope.Result, target)
}

var labelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func validDomain(domain string) bool {
	if len(domain) > 253 || !strings.HasSuffix(domain, ".apexfission.com") {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if !labelPattern.MatchString(label) {
			return false
		}
	}
	return true
}
func wizard() error {
	// Keep first-time compilation of large provider SDKs within a modest memory budget.
	if os.Getenv("GOMEMLIMIT") == "" {
		_ = os.Setenv("GOMEMLIMIT", "1200MiB")
	}
	if os.Getenv("GOGC") == "" {
		_ = os.Setenv("GOGC", "20")
	}

	root, err := os.Getwd()
	if err != nil {
		return err
	}
	// Both launchers start in backend/ so go run resolves its module.
	root = filepath.Dir(root)
	infra := filepath.Join(root, "infra")
	if _, err = os.Stat(filepath.Join(infra, "Pulumi.yaml")); err != nil {
		return fmt.Errorf("start with deploy.bat or deploy.sh from the repository")
	}
	fmt.Println("Audit — AWS + Cloudflare deployment wizard")
	fmt.Println("Target: audit.apexfission.com. On-device AI plus optional hosted Gemma.")
	fmt.Println("1/6 Check tools and accounts")
	for _, name := range []string{"node", "npm", "go", "aws", "pulumi"} {
		if _, err = exec.LookPath(name); err != nil {
			return fmt.Errorf("install %s and restart your terminal; see docs/aws-deployment.md", name)
		}
	}
	if err = run(root, "node", "--version"); err != nil {
		return err
	}
	if err = run(root, "go", "version"); err != nil {
		return err
	}
	settingsPath := filepath.Join(root, ".deploy", "settings.json")
	saved, err := loadSettings(settingsPath)
	if err != nil {
		return fmt.Errorf("read saved setup: %w", err)
	}
	configure := false
	for _, arg := range os.Args[1:] {
		if arg == "--configure" {
			configure = true
		} else {
			return fmt.Errorf("unknown option %s (supported: --configure)", arg)
		}
	}
	profileDefault := os.Getenv("AWS_PROFILE")
	if profileDefault == "" {
		profileDefault = "auto"
	}
	profile, err := choose("AWS profile (auto = current credentials)", saved.Profile, profileDefault, configure)
	if err != nil {
		return err
	}
	if profile != "auto" {
		if err = os.Setenv("AWS_PROFILE", profile); err != nil {
			return err
		}
	}
	identity, err := awsIdentity(root, profile)
	if err != nil {
		return err
	}
	var caller struct {
		Account string
		Arn     string
	}
	if err = json.Unmarshal(identity, &caller); err != nil {
		return err
	}
	fmt.Printf("AWS account: %s\nIdentity: %s\n", caller.Account, caller.Arn)
	if saved.Account != "" && saved.Account != caller.Account {
		return fmt.Errorf("AWS account differs from saved setup (%s); use the original credentials", saved.Account)
	}
	region, err := choose("AWS region", saved.Region, "us-east-1", configure)
	if err != nil {
		return err
	}
	stack, err := choose("Pulumi stack", saved.Stack, "dev", configure)
	if err != nil {
		return err
	}
	if strings.HasPrefix(stack, "-") || strings.Contains(stack, "/") {
		return fmt.Errorf("use a simple stack name such as dev")
	}
	domain, err := choose("Site hostname", saved.Domain, "audit.apexfission.com", configure)
	if err != nil {
		return err
	}
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	if !validDomain(domain) {
		return fmt.Errorf("use a valid subdomain of apexfission.com, such as audit.apexfission.com")
	}
	bucket, err := choose("S3 state bucket", saved.StateBucket, "little-lens-state-"+caller.Account+"-"+region, configure)
	if err != nil {
		return err
	}
	if !validBucket(bucket) {
		return fmt.Errorf("state bucket must be 3–63 lowercase letters, digits or hyphens")
	}
	if saved.StateBucket != "" && (bucket != saved.StateBucket || region != saved.Region || stack != saved.Stack) {
		return fmt.Errorf("changing state bucket, region or stack requires deliberate state migration; see the deployment guide")
	}
	setup := settings{Profile: profile, Account: caller.Account, Region: region, Stack: stack, Domain: domain, StateBucket: bucket, KMSKey: saved.KMSKey}
	fmt.Println("2/6 Prepare S3 state backend and KMS secrets")
	// Do not silently create a duplicate stack when upgrading an existing deployment.
	currentBackend, _ := command(infra, "pulumi", "whoami", "--verbose").Output()
	sameBackend := strings.Contains(string(currentBackend), "s3://"+setup.StateBucket+"/little-lens")
	if saved.StateBucket == "" && !sameBackend {
		cmd := command(infra, "pulumi", "stack", "export", "--stack", stack, "--non-interactive")
		if data, e := cmd.Output(); e == nil {
			var state struct {
				Deployment struct{ Resources []json.RawMessage }
			}
			if json.Unmarshal(data, &state) == nil && len(state.Deployment.Resources) > 1 {
				return fmt.Errorf("existing stack found in the previous backend; migrate its state before using the S3 wizard (see docs/aws-deployment.md)")
			}
		}
	}
	fmt.Printf("State: %s\nA private versioned state bucket and KMS key are prepared before the application preview.\n", backendURL(setup))
	if err = ensureState(root, &setup); err != nil {
		return err
	}
	if err = saveSettings(settingsPath, setup); err != nil {
		return err
	}
	if err = os.Setenv("PULUMI_BACKEND_URL", backendURL(setup)); err != nil {
		return err
	}
	if err = loginStateBackend(infra, root, profile, backendURL(setup), caller.Account); err != nil {
		return err
	}
	// List first so authentication/backend errors are never treated as a missing stack.
	listing, err := output(infra, "pulumi", "stack", "ls", "--json", "--non-interactive")
	if err != nil {
		return err
	}
	var stacks []struct {
		Name string `json:"name"`
	}
	if err = json.Unmarshal(listing, &stacks); err != nil {
		return err
	}
	exists := false
	for _, entry := range stacks {
		if entry.Name == stack {
			exists = true
		}
	}
	if exists {
		err = run(infra, "pulumi", "stack", "select", stack, "--non-interactive")
	} else {
		err = run(infra, "pulumi", "stack", "init", stack, "--secrets-provider", secretsURL(setup), "--non-interactive")
	}
	if err != nil {
		return err
	}
	// Restore stack configuration (including encrypted secrets) on a new checkout.
	if _, statErr := os.Stat(filepath.Join(infra, "Pulumi."+stack+".yaml")); exists && os.IsNotExist(statErr) {
		if err = run(infra, "pulumi", "config", "refresh", "--force", "--non-interactive"); err != nil {
			return err
		}
	}
	if err = setupBedrock(infra, region); err != nil {
		return err
	}
	fmt.Println("3/6 Check Cloudflare DNS access")
	fmt.Println("Use an API token scoped to apexfission.com with Zone:Read and DNS:Edit. Do not use the Global API Key.")
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if token == "" {
		token = configValue(infra, "cloudflare:apiToken", "")
	}
	if token == "" {
		fmt.Print("Cloudflare API token (hidden; no credential available to reuse): ")
		bytes, e := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if e != nil {
			return fmt.Errorf("cannot read hidden token; set CLOUDFLARE_API_TOKEN locally and rerun")
		}
		token = strings.TrimSpace(string(bytes))
	}
	if token == "" {
		return fmt.Errorf("Cloudflare API token is required")
	}
	// Reuse the token through the environment; save it only as a KMS-encrypted Pulumi secret.
	if err = os.Setenv("CLOUDFLARE_API_TOKEN", token); err != nil {
		return err
	}
	var zones []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err = cfGet(token, "/zones?name=apexfission.com", &zones); err != nil {
		return err
	}
	if len(zones) != 1 {
		return fmt.Errorf("token must be able to read the apexfission.com zone")
	}
	zoneID := zones[0].ID
	if err = setSecret(infra, "cloudflare:apiToken", token); err != nil {
		return err
	}
	var records []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}
	if err = cfGet(token, "/zones/"+zoneID+"/dns_records?name="+url.QueryEscape(domain), &records); err != nil {
		return err
	}
	if len(records) > 0 {
		// Only reuse records already owned by this stack; never overwrite another site.
		data, e := output(infra, "pulumi", "stack", "export")
		if e != nil {
			return e
		}
		var state struct {
			Deployment struct {
				Resources []struct {
					URN string `json:"urn"`
					ID  string `json:"id"`
				} `json:"resources"`
			} `json:"deployment"`
		}
		if e = json.Unmarshal(data, &state); e != nil {
			return e
		}
		managed := ""
		for _, resource := range state.Deployment.Resources {
			if strings.HasSuffix(resource.URN, "::site-dns") {
				managed = resource.ID
			}
		}
		if len(records) != 1 || managed != records[0].ID {
			return fmt.Errorf("%s already has DNS records not owned by this stack; use another hostname or deliberately import the existing record before rerunning (see guide)", domain)
		}
	}
	for _, pair := range [][2]string{{"aws:region", region}, {"domain", domain}, {"cloudflareZoneId", zoneID}} {
		if err = run(infra, "pulumi", "config", "set", pair[0], pair[1]); err != nil {
			return err
		}
	}
	fmt.Printf("\nStack: %s\nRegion: %s\nURL: https://%s\nCloudflare: DNS-only CNAME, HTTPS certificate validation record\n", stack, region, domain)
	fmt.Println("4/6 Install dependencies, test, and build (cloud-only frontend)")
	if err = run(root, "npm", "ci"); err != nil {
		return err
	}
	if err = run(root, "npm", "test"); err != nil {
		return err
	}
	if err = run(filepath.Join(root, "backend"), "go", "test", "./..."); err != nil {
		return err
	}
	if err = run(root, "npm", "run", "build:aws"); err != nil {
		return err
	}
	if err = run(infra, "go", "test", "./..."); err != nil {
		return err
	}
	fmt.Println("5/6 Preview application infrastructure (state bucket and KMS are already prepared)")
	if err = run(infra, "pulumi", "preview", "--diff"); err != nil {
		return err
	}
	fmt.Println("6/6 Deploy — creates/updates billable AWS resources and DNS records")
	confirmed, err := confirmDeployment()
	if err != nil {
		return err
	}
	if !confirmed {
		fmt.Println("Stopped after preview. Application not deployed; state bucket, KMS key and saved setup are retained.")
		return nil
	}
	deploy := command(infra, "pulumi", "up", "--yes", "--non-interactive")
	deploy.Stdout, deploy.Stderr = os.Stdout, os.Stderr
	if err = deploy.Run(); err != nil {
		fmt.Println("If AWS reports Signature expired, synchronize Windows time (Settings > Time & language > Date & time > Sync now), then retry. Slow uploads and clock drift can both expire signed requests.")
		fmt.Println("If Pulumi reports recovered raw state mismatch, use the same backend and stack, run pulumi refresh --stack " + stack + " from infra, review the result, then rerun this wizard. Do not remove the stack or delete its state.")
		return fmt.Errorf("deployment incomplete: %w; rerun this wizard with the same stack to resume", err)
	}
	if values, e := output(infra, "pulumi", "stack", "output", "--json"); e == nil {
		if e = saveLocalRuntime(root, region, values); e != nil {
			fmt.Println("Deployment succeeded; local runtime settings could not be saved:", e)
		}
	}
	result := command(infra, "pulumi", "stack", "output", "url")
	result.Stdout, result.Stderr = os.Stdout, os.Stderr
	if err = result.Run(); err != nil {
		return err
	}
	fmt.Printf("Open https://%s in Chrome on your phone. DNS and certificate provisioning may take time.\n", domain)
	fmt.Printf("Check https://%s/api/health for backend health.\n", domain)
	return nil
}
