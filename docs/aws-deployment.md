# Deploy Little Lens to AWS

## What runs where

- CloudFront serves `https://audit.apexfission.com` with an ACM certificate issued in `us-east-1`. Cloudflare hosts DNS-only CNAME records for the site and certificate validation. HTTP requests for the app redirect to HTTPS. Without a configured custom domain, the stack also supports the included `*.cloudfront.net` certificate.
- Private S3 stores the Vite build, including WASM runtime files. Only this CloudFront distribution can read them through origin access control.
- `/api/*` goes to API Gateway HTTP API and an ARM64 Go Lambda. `GET /api/health` returns JSON. `GET /api/cloud` reports whether cloud categorization is configured; `POST /api/classify` forwards a validated resized JPEG and prompt to hosted Gemma. These endpoints are public and throttled, not authenticated.
- SmolVLM2 still downloads directly from Hugging Face and runs on the phone. In on-device mode, photos are never sent to AWS. Optional cloud mode sends prepared photos through AWS to Google after user consent. Moving hosts means the browser has a new origin/cache and will download the model again.
- CloudWatch retains Lambda logs for 14 days. API traffic is throttled to 10 requests/second with a burst of 20. These limits are not a spending cap.

No Docker, VPC, NAT gateway, always-on compute, database, GPU instance is required. AWS usage charges apply for storage, delivery, requests, Lambda, and logs. The model download itself is not served by AWS.

## Prerequisites

Install Node 22.12+ (or Node 24), Go 1.25+, Pulumi CLI, and AWS CLI v2. Configure AWS credentials for the target account, preferably using AWS SSO. The deployment identity needs permissions to manage S3, CloudFront, Lambda, API Gateway v2, CloudWatch Logs, ACM, and IAM roles/policies including `iam:PassRole`.

## Guided deployment (recommended)

Windows PowerShell:

```powershell
.\deploy.bat
```

Linux/macOS:

```sh
sh ./deploy.sh
```

Both launchers work when invoked from another directory. The wizard itself is written in Go. The first run offers these defaults; press Enter to accept:

| Setting | Default |
| --- | --- |
| AWS profile | `AWS_PROFILE` if set, otherwise `auto` (current credential chain) |
| AWS region | `us-east-1` |
| Pulumi stack | `dev` |
| Hostname | `audit.apexfission.com` |
| S3 state bucket | `little-lens-state-<AWS-account-ID>-<region>` |
| Final deployment confirmation | `yes` (press Enter to apply; type `n` to cancel) |

Values are stored in ignored `.deploy/settings.json`. Later runs reuse them without questions. Run `.\deploy.bat --configure` or `sh ./deploy.sh --configure` to review settings again. State bucket, region, stack, and account changes require deliberate state migration; the wizard stops rather than creating a second deployment accidentally.

Before running it:

1. Authenticate to AWS, for example `aws sso login --profile YOUR_PROFILE`. Enter that profile on first setup. Expired credentials require signing in again, but the saved profile is retained.
2. Create a Cloudflare API token with **Zone → Zone → Read** and **Zone → DNS → Edit**, limited to **apexfission.com**. The dashboard URL contains the account ID, not the zone ID; the wizard discovers the zone ID automatically.
3. Supply `CLOUDFLARE_API_TOKEN` or paste it into the hidden prompt on first setup. Credentials cannot have fabricated defaults. Once validated, the wizard stores the token as a **KMS-encrypted Pulumi secret**, never in plaintext settings or command-line arguments. Future runs retrieve it automatically. To rotate it, supply a new token in `CLOUDFLARE_API_TOKEN` and rerun.

### S3 state and encrypted secrets

The wizard logs Pulumi into `s3://<bucket>/little-lens?awssdk=v2&region=<region>` (including the selected profile when applicable). No Pulumi Cloud account or token is needed. On the first run it creates/reuses the state bucket, blocks public access, enables versioning and SSE-S3 encryption, and creates/reuses `alias/little-lens-pulumi` in KMS with key rotation. KMS encrypts Pulumi secret values, so there is no separate passphrase prompt.

**The state bucket and KMS key are prepared before the application preview.** They incur AWS storage/KMS charges and remain if you decline the application deployment. They deliberately live outside the application stack: `pulumi destroy` must not delete its own state or encryption key. Keep them until you no longer need any stack state, backup, or encrypted config. Do not schedule the key for deletion while stacks still depend on it.

The AWS identity also needs S3 bucket creation, public-access-block/versioning/encryption management, and state object list/read/write/delete permissions; KMS describe/create-key/create-alias/enable-key-rotation/encrypt/decrypt permissions are needed for bootstrap and secret access. Routine runs verify access and reapply the bucket protections. An inaccessible bucket is not treated as a missing bucket.

After setup the wizard builds and tests, previews the application, and asks only for the final deployment confirmation (Enter accepts; `n` cancels). It checks that AWS account matches the saved account. On a new checkout, use the same settings/backend/stack: it can restore stack config from Pulumi state. Back up `.deploy/settings.json` privately alongside your knowledge of the bucket/key; it contains no token. A failed or interrupted application deployment can be resumed with the same launcher.

The Cloudflare record uses **DNS only** (gray cloud): CloudFront handles TLS and caching. Keep the ACM validation CNAME for automatic certificate renewal. Existing DNS records not managed by the selected stack stop the wizard; it never automatically takes over another site. If you intentionally want to adopt an existing CNAME, inspect it and import it into the selected stack before running the wizard:

```powershell
cd infra
pulumi import cloudflare:index/dnsRecord:DnsRecord site-dns ZONE_ID/RECORD_ID
```

Do not import an apex record or a record serving another application without planning the migration. Existing ACM validation records may similarly need importing as `certificate-dns` if ACM reuses a validation name.

Open the exported URL in Chrome on the phone. Test `https://audit.apexfission.com/api/health` for a JSON health response. Then test model download, a real photo description, and PWA installation. DNS, ACM validation, and CloudFront provisioning can take several minutes. HTTPS resolves secure-context restrictions, but WebGPU still depends on browser and GPU support.

## Manual commands after wizard setup

Use the same AWS profile and backend saved by the wizard. `pulumi login` persists the selected S3 backend locally; verify it with `pulumi whoami -v`. Do not log into Pulumi Cloud for this project.

```powershell
npm ci
npm run build:aws
cd infra
pulumi stack select dev
pulumi preview
pulumi up
pulumi stack output url
```

The Cloudflare provider can read its encrypted token from stack config. If config is absent on a new checkout, select the existing stack and run `pulumi config refresh --force` using credentials permitted to decrypt its KMS key.

### Existing deployments on another backend

Logging into S3 does not migrate an existing stack. The wizard stops if it finds resources in the previous backend. Migrate first using Pulumi's state export/import workflow, preserving the stack's secrets provider and configuration; do not run a new `pulumi up` against empty state. Export from the old backend, bootstrap/select the destination S3 backend, initialize the destination stack, and import the export there. Verify `pulumi preview` proposes no duplicate resources before continuing. Use `pulumi stack change-secrets-provider <awskms-URL>` to migrate existing encrypted config to the KMS provider if needed. Keep the old state until the destination is verified. The wizard does not automatically delete or migrate old stacks.

Reference: https://www.pulumi.com/docs/iac/operations/stack-management/using-a-diy-backend/

## Update an existing deployment

The simplest update is `git pull` followed by the same launcher and stack. For manual updates, keep AWS credentials available (Cloudflare is stored as an encrypted stack secret). From the repository root:

```powershell
git pull
npm ci
npm run build:aws
cd infra
pulumi stack select dev
pulumi preview
pulumi up
```

Builds always use `/` as the Vite base path, even if BASE_PATH is set for GitHub Pages. Pulumi deploys the ZIP and uploads the new frontend build. Hashed `assets/` files have immutable caching. The app shell, service worker, and unversioned runtime files revalidate; CloudFront's minimum TTL is zero. The installed PWA may show its existing "New version available" prompt.

Avoid running concurrent deployments to the same stack. S3 uploads are individual updates, not an atomic release; a user refreshing during deployment may need to reload afterward. Wait for `pulumi up` to complete before sharing the new version. The existing GitHub Pages workflow remains a separate optional deployment.

## Local backend development

In one terminal:

```powershell
cd backend
go run ./cmd/api
```

In another terminal at the repository root:

```powershell
npm run dev
```

Vite proxies `/api` to `127.0.0.1:8080`. The service worker excludes API routes from its navigation fallback. The backend defaults to loopback and can be changed with LISTEN_ADDR. Opening the Vite server through a LAN HTTP address does not provide the secure context required by WebGPU; use the deployed HTTPS address for phone testing.

## Validation

```powershell
npm test
npm run build:aws
cd backend
go test ./...
cd ../infra
go test ./...
pulumi preview
```

CI builds the AWS artifacts and tests both Go modules without AWS credentials. A real Pulumi preview/deployment and phone inference test still require your AWS account and device.

## Remove AWS resources

```powershell
cd infra
pulumi stack select dev
pulumi destroy
```

Provide the same AWS profile with KMS decrypt access. Cloudflare credentials are read from encrypted stack config. This deletes the hosted app, backend, managed S3 objects, log group, ACM certificate, and managed Cloudflare DNS records. The bucket is not configured to force-delete unmanaged objects; remove any manually added objects if they prevent deletion. Only run `pulumi stack rm dev` after successful destruction. Browser model caches are independent and are not removed by destroying the stack.

## Implementation references

- https://www.pulumi.com/registry/packages/aws/api-docs/cloudfront/originaccesscontrol/
- https://www.pulumi.com/registry/packages/aws/api-docs/apigatewayv2/integration/
- https://docs.aws.amazon.com/lambda/latest/dg/golang-package.html


## Optional hosted Gemma

The wizard checks `GEMINI_API_KEY`, then the KMS-encrypted Pulumi `geminiApiKey` setting. If neither exists, it asks for hidden input; Enter skips cloud setup. Create a key at https://aistudio.google.com/apikey. It validates access to `gemma-4-26b-a4b-it` with a metadata request before saving the secret. This does not verify remaining generation quota. Subsequent deployments reuse the key. To rotate it, set `GEMINI_API_KEY` locally before rerunning the wizard.

The frontend never receives the key. Pulumi passes it as a secret to the Lambda environment. Cloud mode has no model download and works without WebGPU. The user must consent before resized JPEGs and the editable prompt are sent to Google. Google's free-tier data may be used to improve its products. The app has no paid-model fallback; quota errors pause processing. AWS infrastructure charges still apply.

The API validates JPEG dimensions, request size, prompt length and consent; provider error bodies are never exposed or logged. A same-origin browser check is not authentication. Anyone able to call the public endpoint can consume its shared quota; add user authorization before wider deployment. Uploads are not stored by this application. See the README for local development, key rotation and disabling cloud mode.
