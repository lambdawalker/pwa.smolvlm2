# Audit

A cloud-only PWA for categorizing photos with **Gemma 4 E2B on Amazon Bedrock**. Upload from your phone or laptop into the same private session, review categories, and export Word or PowerPoint documents from either device.

## Deploy

Install Node 22.12+ (or 24), Go 1.25+, AWS CLI v2, and Pulumi. Use the existing AWS profile and stack:

```powershell
git pull
.\deploy.bat
```

On Linux/macOS, use `sh ./deploy.sh`. The wizard reuses `.deploy/settings.json`, S3 state, KMS secrets and Cloudflare credentials. Defaults target `audit.apexfission.com`, stack `dev`, region `us-east-1`. Expired SSO credentials trigger AWS login when needed. Enter confirms deployment, or it proceeds after the existing five-second countdown; `n` cancels.

No Google API key, Hugging Face token, local model download or browser GPU is required. The wizard verifies Gemma model metadata with your AWS credentials. That check is not a billed generation and does not prove that every inference request will succeed. AWS model access, organization policies, account quotas and billing must permit Bedrock inference.

See [AWS deployment details](docs/aws-deployment.md).

## Photos and sessions

Create an account, verify its email and log in on both devices. Create or open a session. Photo previews appear immediately, while originals and prepared images upload privately in the background. Categorization begins automatically by default; Settings can switch to manual start. Images are scaled to make the shorter side 384 pixels, then center-cropped to 384×384 before inference. Full originals remain available by clicking a photo.

Categories are **Indoors**, **Outdoors**, **Documents**, and **Computer screens**. The editable prompt asks for JSON `{category, description}` with a description of one sentence, as short as possible. The UI limits description length. English and Spanish are supported. Describe is a separate cloud-only page for a single photo and custom prompt.

Sessions can be created, renamed, opened or permanently deleted on the Sessions page. Idle and active pages check for changes every ten seconds without locking controls. Conditional ETags avoid downloading unchanged metadata, and new images load lazily. Photos and metadata are private to the authenticated user. Offline edits are not persistently queued.

## Trash and conflicts

Deleting a photo moves it to **Trash** for 48 hours. Choose a category to restore it. Trash images are excluded from exports and active counters. Stale edits, including delete-versus-edit conflicts, move the image to **Needs attention** for review.

The paper-shredder button permanently deletes an image and overrides conflicting edits. In Trash, the action-bar shredder permanently empties Trash. An AWS EventBridge job checks every five minutes for expired Trash and interrupted shredding, so cleanup works with all browsers closed. Physical cleanup is eventual after the retention deadline and may take additional passes for large backlogs or failed requests. Deleting an entire session remains permanent.

## Documents

PowerPoint is the default; Word is also available. Both default to portrait, two columns, seven rows, descriptions off. Category headings separate sections. All layouts use borderless photo grids with small gutters and optional descriptions below images. Generated documents download automatically. Grid/list views, mobile category swiping, image removal, and left-handed controls are available.

Defaults are in `config/categorization-defaults.yaml`; `npm run defaults` regenerates `src/defaults.generated.js`. Saved browser preferences override applicable defaults.

## AWS inference

The Go API calls `google.gemma-4-e2b` at the regional **bedrock-mantle** `/openai/v1/chat/completions` endpoint. It signs requests with AWS SigV4 using the Lambda role; no API key reaches the browser. Pulumi grants `bedrock-mantle:CreateInference` with the model and region restricted by IAM conditions. Gemma 4 is not routed through the native Bedrock Converse/InvokeModel endpoint.

Default region is `us-east-1`; supported regions are `us-east-1`, `us-east-2`, `us-west-2`, and `eu-central-1`. Override with `pulumi config set bedrockRegion REGION` in `infra`. Disable inference with `pulumi config set bedrockEnabled false` and deploy. Bedrock on-demand requests are billed by AWS; this setup does not provision an always-on GPU instance. Runtime precision is AWS-managed and not disclosed.

Prepared JPEGs, prompts and returned text are validated/bounded. Provider bodies, AWS credentials and reasoning text are never forwarded to the browser or logged. Requests share a 25-second deadline; only explicit transient server errors retry, up to three attempts. Throttles and access failures do not retry silently. There is no Google fallback.

Existing encrypted `geminiApiKey` config is unused. You may remove it with `pulumi config rm geminiApiKey` and revoke the old key in Google Cloud. Do not remove other stack state or KMS keys.

## Local development

The local launcher runs the web app and Go API on your computer; **inference still runs in AWS**. It reuses the AWS profile/region from `.deploy/settings.json` or environment variables. Authenticate first:

```powershell
aws sso login --profile attestra
.\local.bat
```

Use `sh ./local.sh` on Linux/macOS. Set `AWS_PROFILE` and `BEDROCK_REGION` to override saved values. The local identity needs `bedrock-mantle:GetModel` for the startup check and `bedrock-mantle:CreateInference` for the selected model. AWS credentials are passed only to the Go process, not Vite. To test accounts and sessions locally, also supply the existing stack's `COGNITO_POOL_ID`, `COGNITO_CLIENT_ID`, `AWS_REGION`, `SESSIONS_TABLE` and `PHOTOS_BUCKET`.

Static hosting/`npm run preview` can preview the interface, but cloud inference and shared sessions require the Go API. Phone browser access should use HTTPS; the deployed PWA does not require WebGPU. The old model-download URL redirects to Categorize. Retired browser model caches are cleared on the next updated-page load.

## Deployment size and order

The build no longer ships Transformers.js, model workers, ONNX WASM binaries or browser model downloads. The frontend precache is about 0.85 MiB rather than about 54 MiB (exact size depends on the build).

1. Upload the Lambda ZIP to the private artifact bucket when its content hash changes.
2. Update Lambda, its model permissions, API and other backend dependencies.
3. Upload frontend assets.
4. Publish HTML, manifest and service worker after their referenced assets.

The Lambda update contains an S3 reference, not the ZIP bytes. The build disables VCS stamping and uses a deterministic ZIP, so frontend-only Git commits do not change the backend package. The ZIP must still upload when backend code or compiler output changes; dependency ordering cannot remove that requirement. Slow networks and AWS resource provisioning can still dominate deployment time.

## Validation

```sh
npm ci
npm test
npm run build:aws
cd backend && go test ./...
cd ../infra && go test ./...
```

Tests cover cloud request validation/signing/retries, browser flows, image crops, private sessions, conflicts, Trash, document XML, and Pulumi configuration. Local-model tests were retired with the removed feature. Live AWS model inference and two-device sync require a deployed account and real photos. The existing GitHub Pages workflow publishes a static UI preview separately from the AWS app.

### Recovering photos

Use **Retry failed photos** to upload failed photos again in place and resume pending or failed categorization, including in manual mode. Use **Restart categorization** to rerun active photos with the current prompt. Trash and unresolved sync conflicts are excluded. Both controls are in the bottom action bar and are disabled while a recovery is in progress. Keep the page open to retain files whose upload has not succeeded.

### Checking for updates

The cloud button is green after a successful sync. Background checks only detect changes; they never replace photos or session choices. When incoming changes are found, the button turns red. Press it to apply the latest cloud state, including conflict and Trash handling. Uploads and local edits continue saving immediately. The button stays at the far right of the status row, or at the far left with left-handed controls enabled.
