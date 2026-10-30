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

Create an account, verify its email and log in on both devices. Create or open a session. Photo previews appear immediately, while originals and prepared images upload privately in the background. When an upload finishes, categorization is queued automatically in AWS and continues after the browser closes. Settings records AWS consent and the prompt for each new job. Images are scaled to make the shorter side 384 pixels, then center-cropped to 384×384 before inference. Full originals remain available by clicking a photo.

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

Prepared JPEGs, prompts and returned text are validated/bounded. Provider bodies, AWS credentials and reasoning text are never forwarded to the browser or logged. Requests share a 25-second deadline; only explicit transient server errors retry, up to three attempts. Background jobs retry transient failures and throttles up to three worker attempts; access/configuration failures stop for manual review. There is no Google fallback.

Existing encrypted `geminiApiKey` config is unused. You may remove it with `pulumi config rm geminiApiKey` and revoke the old key in Google Cloud. Do not remove other stack state or KMS keys.

## Local development

The local launcher runs the web app and Go API on your computer; **inference still runs in AWS**. It reuses the AWS profile/region from `.deploy/settings.json` or environment variables. Authenticate first:

```powershell
aws sso login --profile attestra
.\local.bat
```

Use `sh ./local.sh` on Linux/macOS. Set `AWS_PROFILE` and `BEDROCK_REGION` to override saved values. The local identity needs `bedrock-mantle:GetModel` for the startup check and `bedrock-mantle:CreateInference` for the selected model. AWS credentials are passed only to the Go process, not Vite. After deployment, the wizard saves public resource identifiers in `.deploy/runtime.json`; the launcher reuses them for signed-in sessions and background categorization. Explicit environment variables override those identifiers. Without deployed sessions, use Describe for a local single-photo request.

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

Upload failures keep their local previews. **Retry uploads** resends failed files in place. Categorization itself has no batch start/stop/restart controls: it runs in AWS. A failed or invalid result has a per-photo **Retry** action; completed photos have **Reclassify**, using the current prompt. Keep the page open until file uploads finish; once the job is recorded, closing the page does not interrupt processing.

### Checking for updates

The PWA checks every five seconds and on focus, then automatically applies incoming photo results, session changes, conflicts and Trash changes. Uploads and local edits remain interactive. The cloud icon stays green when synchronized and indicates pending updates while applying them; pressing it retries a failed sync. Unchanged cards and images remain mounted to avoid blinking. Upload and processed icons animate while work is active; there is no overall progress bar. The cloud button stays at the far right of the status row, or at the far left with left-handed controls enabled.

### Duplicate detection and indexing existing photos

New photos are identified by **SHA-256 of the original file bytes**, followed by an exact **64-bit dHash** match. The dHash follows the provided Kotlin comparison: resize the full decoded original to 9×8, compare horizontal neighbors with `30R + 59G + 11B`, and set bits from least to most significant in row order. It is stored as 16 hexadecimal characters (`dhash-8-v1`), never a JavaScript number. This happens before the separate 384×384 inference crop. Renaming a file does not change either hash. Re-encoding or changing file metadata changes SHA-256; this feature deliberately does not merge merely similar images.

Duplicates are scoped to the selected session, including Trash. The browser reports skipped copies and avoids uploading or categorizing them. The server uses conditional DynamoDB hash reservations to prevent concurrent uploads of the same pair from two devices. After upload, it streams the S3 original through SHA-256 before accepting the photo as verified. dHash is a browser-computed visual confirmation, not a cryptographic security or authorization check. Small decoder/resizer differences between browsers can conservatively miss duplicates; the app never uses dHash alone to merge images.

For older sessions, open **Settings → Duplicate photos → Index existing photos**. Run it for each session that already contains photos. It downloads originals one at a time, calculates both hashes, and verifies the byte hash in AWS. Keep the page open; this consumes bandwidth. Progress is shown, **Stop indexing** cancels, and running it again resumes missing hashes after a failure. Existing duplicates are reported but retained; categories, descriptions, originals and Trash are preserved. Updated metadata appears automatically.

Hash reservations are released on shredding and removed on session deletion. A replacement gets a new photo ID so stale clients cannot affect it. If a device disappears halfway through an upload, a later retry can retire an abandoned reservation after ten minutes. No extra AWS resource or model API call is needed for hashing.

If a session already has repeated images, indexing checks all its photos (without downloading originals again when their hashes are verified). Then use **Move duplicate copies to Trash**. Cleanup groups only exact SHA-256 + dHash pairs, retains one active photo per group (preferring a categorized copy), and moves the rest to Trash in resumable batches. Copies already in Trash are left alone. Descriptions and raw results stay with their respective copies; no information is merged or permanently deleted by cleanup. Photos without verified hashes are excluded until indexed. The visible session updates automatically. Trash retains the existing two-day recovery window.

### Durable background categorization

Upload finalization atomically updates the photo and creates a job in DynamoDB. DynamoDB Streams dispatches the job to SQS, and a separate ARM64 Lambda processes it with Gemma. The worker uses a conditional lease and job ID, so duplicate deliveries do not repeat an inference whose result was committed and late results cannot overwrite manual edits, Trash, shredding or a newer job. A five-minute recovery pass uses a sparse wake-time index to resend stalled jobs if stream dispatch or a worker was interrupted.

The worker timeout is 60 seconds; queue visibility is 360 seconds. There are three application attempts for transient failures and two concurrent workers by default. `pulumi config set classificationConcurrency 3` allows three workers. The queue has a dead-letter queue for repeated infrastructure failures. No always-on server is added. Inference and queue/Lambda use are billed by AWS. Job prompts and consent are captured before processing; changing Settings affects future jobs, and Reclassify explicitly creates a new job. Existing unprocessed photos are queued when a signed-in session is opened with consent enabled.

Results are saved automatically in AWS. The PWA automatically applies queued, processing, retrying, completed and failed results while it is open. Moving a queued photo to Trash prevents further processing when the worker observes it; an already running provider request may finish, but its result cannot restore the photo. Describe remains an interactive single-photo request, separate from this durable session workflow.

### Undo and saved preferences

The Undo button keeps a browser-local action stack for photo uploads (undo moves them to Trash), category edits, reclassification, Trash moves/restores, duplicate cleanup, view changes and Settings controls. Shredding cannot be undone. Automatic worker result revisions do not invalidate Undo, while newer manual edits on another device are preserved. Failed Undo writes retain the remaining action for retry. History lasts for the open page; it is not synchronized between devices or restored after reload. It does not reverse a downloaded document, account operation or permanent session deletion.

Settings → Controls configures the history limit (1–100 actions, default 20) and bulk-delete hold time (2 or 3 seconds, default 3). Delete all and Shred all require a continuous pointer or keyboard hold followed by a separate confirmation dialog. Releasing early, cancelling the pointer, leaving the button or losing focus cancels the hold. The dialog targets only the photos present when it opened.

Document format, portrait/landscape orientation, rows, columns, layout and Add description are saved in this browser, alongside language, handedness, prompt, consent, view and diagnostic preferences. Saved valid values override YAML defaults. Undoing settings also saves the restored values. Language changes apply without reloading or discarding the Undo stack.

### PNG page exports

Select **PNG images (.png)** in Categorization settings, then use the download button. PNG uses the same category grouping, rows and columns as the Office exports: four planned document pages produce four PNG files. A single page downloads directly as PNG; multiple pages download together in one ZIP with numbered category filenames. Export runs in the browser and does not call the model again.

PNGs contain a tightly packed photo grid, category heading and optional descriptions below the photos. There are no borders or page backgrounds; the small internal gutters are transparent. Empty trailing rows/columns and transparent outer padding are trimmed from each page. Images retain their page's photo size rather than stretching a partial page to fill a whole sheet.

Print density is embedded as 300 DPI. Portrait exports fit within 6.25 × 8.75 inches; landscape exports fit within 8.75 × 6.25 inches before the final content trim. These bounds accommodate standard Letter/A4 Word text areas in the matching orientation. Word templates with custom margins, existing content or insertion-size preferences can still require adjustment. PNG is a flattened image; use Word export when editable captions and headings are needed.

### Photo tools

Use Select for bulk category changes, Trash moves, reclassification, and exporting a selection. Click a description to edit it (180 characters). Drag cards to reorder on desktop; the up/down buttons work on touch devices. Ordering is saved with each photo and used for exports. Search filters descriptions/categories; the Sessions page also searches session names.

Categories adds custom session categories alongside the standard categories. New classification jobs include those categories; existing jobs/photos retain their current results. Preview renders the same image grid and category pagination; Word/PowerPoint margins can differ from the grid preview.

Pending original files are saved in IndexedDB, scoped to the signed-in account and session. Reopen the session and use Resume uploads after interruption. Completed uploads and duplicates remove their pending record. Browser storage eviction, private browsing restrictions, or a full disk can prevent recovery; an on-screen notice explains when the page must remain open. Audit does not promise uploads will continue after the browser closes.
