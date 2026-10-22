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
	fmt.Println("Little Lens — AWS + Cloudflare deployment wizard")
	fmt.Println("Target: audit.apexfission.com. Model inference stays on the device.")
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
	profile, err := ask("AWS profile (blank uses current credential chain)", os.Getenv("AWS_PROFILE"))
	if err != nil {
		return err
	}
	if profile != "" {
		if err = os.Setenv("AWS_PROFILE", profile); err != nil {
			return err
		}
	}
	if err = run(root, "aws", "sts", "get-caller-identity"); err != nil {
		return fmt.Errorf("AWS authentication failed; run aws sso login --profile YOUR_PROFILE, then restart the wizard")
	}
	if err = run(infra, "pulumi", "whoami"); err != nil {
		fmt.Println("Log in to your Pulumi state backend. Choose 'cloud' for Pulumi Cloud, 'local' for this computer, or enter a backend URL.")
		backend, e := ask("Pulumi backend", "cloud")
		if e != nil {
			return e
		}
		args := []string{"login"}
		if backend == "local" {
			args = append(args, "--local")
		} else if backend != "cloud" {
			args = append(args, backend)
		}
		if err = run(infra, "pulumi", args...); err != nil {
			return err
		}
	}
	fmt.Println("2/6 Select stack and hostname")
	stack, err := ask("Pulumi stack (existing or new)", "dev")
	if err != nil {
		return err
	}
	if strings.HasPrefix(stack, "-") {
		return fmt.Errorf("invalid stack name")
	}
	if err = run(infra, "pulumi", "stack", "select", "--create", stack); err != nil {
		return err
	}
	region, err := ask("AWS region", configValue(infra, "aws:region", "us-east-1"))
	if err != nil {
		return err
	}
	domain, err := ask("Site hostname", configValue(infra, "domain", "audit.apexfission.com"))
	if err != nil {
		return err
	}
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	if !validDomain(domain) {
		return fmt.Errorf("use a valid subdomain of apexfission.com, such as audit.apexfission.com")
	}
	fmt.Println("3/6 Check Cloudflare DNS access")
	fmt.Println("Use an API token scoped to apexfission.com with Zone:Read and DNS:Edit. Do not use the Global API Key.")
	token := os.Getenv("CLOUDFLARE_API_TOKEN")
	if token == "" {
		fmt.Print("Cloudflare API token (hidden): ")
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
	// The token is inherited by Pulumi, never passed as a CLI argument or saved to a file.
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
	fmt.Println("4/6 Install dependencies, test, and build")
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
	fmt.Println("5/6 Preview infrastructure (no cloud resources created yet)")
	if err = run(infra, "pulumi", "preview", "--diff"); err != nil {
		return err
	}
	fmt.Println("6/6 Deploy — creates/updates billable AWS resources and DNS records")
	confirm, err := ask("Type DEPLOY to proceed; anything else exits", "no")
	if err != nil {
		return err
	}
	if confirm != "DEPLOY" {
		fmt.Println("Stopped after preview. No deployment requested.")
		return nil
	}
	if err = run(infra, "pulumi", "up", "--yes"); err != nil {
		return fmt.Errorf("deployment incomplete: %w; rerun this wizard with the same stack to resume", err)
	}
	if err = run(infra, "pulumi", "stack", "output", "url"); err != nil {
		return err
	}
	fmt.Printf("Open https://%s in Chrome on your phone. DNS and certificate provisioning may take time.\n", domain)
	fmt.Printf("Check https://%s/api/health for backend health.\n", domain)
	return nil
}
