# Deploy Audit to AWS

## Services

- CloudFront and a private S3 website bucket serve `https://audit.apexfission.com`.
- Cloudflare has DNS-only records for the domain and ACM validation. ACM uses `us-east-1` for CloudFront certificates.
- API Gateway HTTP API routes `/api/*` to an ARM64 Go Lambda.
- Cognito handles signup, email verification, login and password resets.
- DynamoDB stores user-owned sessions, photo revisions, conflicts and Trash state.
- A separate encrypted, private S3 bucket stores original and prepared photos.
- Amazon Bedrock runs `google.gemma-4-e2b` through the Mantle OpenAI-compatible endpoint.
- EventBridge invokes Trash cleanup every five minutes. CloudWatch retains application logs for fourteen days.
- A separate private S3 artifact bucket stages encrypted Lambda ZIPs; the code update references their hash-addressed keys.
- A private, versioned S3 state bucket and KMS key hold Pulumi state and encrypted configuration.

No browser model runtime, Google inference API key, self-managed GPU, Docker build, VPC or NAT gateway is required. AWS charges apply to actual service use, including Bedrock inference. Bedrock is a managed model service; this stack does not provision dedicated model-server compute.

## Wizard

Install Node 22.12+ / 24, Go 1.25+, Pulumi CLI and AWS CLI v2. From the repository root:

```powershell
git pull
.\deploy.bat
```

Or `sh ./deploy.sh` on Linux/macOS. The default AWS region is `us-east-1`, stack `dev`, domain `audit.apexfission.com`. Profile defaults to `AWS_PROFILE` or the current credential chain (`auto`). Values persist in ignored `.deploy/settings.json`; reruns skip known questions. `--configure` reviews them again. Reuse the same profile/account/backend/stack to update an existing deployment.

The wizard validates AWS identity, logs into S3 state, checks Cloudflare DNS access, verifies the Bedrock model's metadata using signed AWS requests, installs/builds/tests, previews, then applies. Enter accepts deployment; `n` cancels; the existing five-second countdown applies. Metadata checks do not generate tokens or prove inference entitlement. The wizard uses `/v1/models/{model}` for discovery, not `/openai/v1/models`.

Cloudflare requires a token restricted to the zone with Zone Read and DNS Edit. The wizard discovers the zone ID and saves its token as a KMS-encrypted Pulumi secret. No Google API-key prompt remains. Account/region/stack/state changes require deliberate migration rather than a second empty deployment.

The deployment identity needs permissions for the resources above, including IAM roles/policies and PassRole; the Bedrock metadata preflight needs `bedrock-mantle:GetModel`. Your account and organization policies must allow the model. For an access-denied response, check the Bedrock console and model terms/access in the configured region. The runtime role's inference permission is restricted to `google.gemma-4-e2b` and the chosen region using `bedrock-mantle:Model` and `aws:RequestedRegion` conditions. It uses `bedrock-mantle:CreateInference`, not `bedrock:InvokeModel`.

## Bedrock configuration

```powershell
cd infra
pulumi config set bedrockRegion us-east-1
pulumi config set bedrockEnabled true
```

Supported E2B regions are `us-east-1`, `us-east-2`, `us-west-2`, `eu-central-1`. The wizard retains a saved Bedrock region. For a stack outside supported regions it defaults the inference region to `us-east-1` and prints that choice. No automatic model or Google fallback exists. To disable inference, set `bedrockEnabled false` and deploy.

Lambda receives `BEDROCK_ENABLED` and `BEDROCK_REGION`, plus the existing account/storage configuration. Requests use AWS SigV4 service name `bedrock-mantle`, temporary role credentials and `/openai/v1/chat/completions`. JPEG data is inline, so the model does not receive a public photo URL. The UI sends a 384×384 center crop; original photos stay in private S3.

The provider response must finish normally; empty, truncated, refused or malformed responses are surfaced safely. Only transient 500/502/503/504 responses retry, with a total deadline of 25 seconds. Prompts, image data, AWS credentials and provider response bodies are not logged. Bedrock manages runtime precision. Test model accuracy and latency with your actual photo set after deployment.

Existing `geminiApiKey` stack config is not consumed or passed to Lambda. It may be removed with `pulumi config rm geminiApiKey`; revoke its old Google key separately if no longer needed. Pulumi state history may retain encrypted historical values.

## Package uploads and deployment order

A changed Lambda ZIP uploads to its private S3 artifact bucket before Lambda can load it. The Lambda API request then contains only an S3 reference and code hash. Frontend asset uploads depend on backend/API readiness, and HTML, manifest and service worker uploads depend on the assets. This prioritizes backend changes and avoids a long inline Lambda upload.

`go build -buildvcs=false` prevents unrelated frontend Git commits from changing the backend binary. The ZIP has deterministic headers. When the package bytes are unchanged, the content-addressed object and Lambda source hash remain unchanged, avoiding a repeat upload. A changed backend, Go compiler or dependencies can legitimately produce a new ZIP. Uploading a changed package cannot be skipped.

The cloud-only frontend removes approximately 54 MiB of browser inference runtime/weights from the precache; the remaining app shell and document libraries are under 1 MiB in the current build. Static uploads are individual updates, not an atomic website release. Reload the app when its update prompt appears. Do not deploy the same stack concurrently.

For `InvalidSignatureException: Signature expired`, synchronize the computer clock in Windows Settings → Time & language → Date & time → Sync now. Delayed requests can cause the same error. If a failed update also reports recovered raw state mismatch, use the same backend/stack and run `pulumi refresh --stack dev` from `infra`, review the result, then rerun the wizard. Keep the state intact; do not destroy/recreate the stack or remove lock/state files blindly.

## State, accounts and data

The state bucket has public access blocked, versioning and encryption. KMS secrets use the existing `alias/little-lens-pulumi`. The wizard prepares this state backend before preview; it remains if deployment is declined. Preserve the bucket and KMS key while any stack or backups depend on them. Restoring a checkout requires the same backend and decrypt access; `pulumi config refresh --force` restores config after selecting the correct stack.

Session and photo endpoints check the Cognito access token and partition every lookup by user. S3 URLs are short-lived (five-minute PUT, fifteen-minute GET). Originals are limited to 25 MiB; upload finalization checks both stored object sizes. Browser tokens stay in tab session storage, not the app bundle. API responses are `no-store`.

Photo edits use revision checks. Conflicts persist in Needs attention. Photo deletion moves to Trash for 48 hours; choosing a category restores it. Explicit shredding (`DELETE` with `{permanent:true}`) writes a tombstone before file removal and wins over stale edits. Plain DELETE from older clients moves active photos to Trash. Scheduled cleanup conditionally expires Trash and retries interrupted shredding; large backlogs may require additional passes. Session deletion remains permanent and removes its entire contents. Offline edits are not persistently queued.

The Cognito pool uses default email delivery for verification/reset. Configure SES delivery when production volume requires it. There is no account administration or account deletion UI. Do not destroy the stack to update it: destroying removes login identities/session metadata; nonempty data buckets deliberately prevent force deletion.

## Local development

`local.bat` / `local.sh` run Vite and the Go API, but inference remains in AWS. Reuse your saved profile or set `AWS_PROFILE`; sign in with `aws sso login --profile YOUR_PROFILE`. Set `BEDROCK_REGION` when needed. Only the Go API receives AWS credentials. The browser/Vite process receives no AWS credential environment variables. For local account/session integration, supply the deployed `COGNITO_POOL_ID`, `COGNITO_CLIENT_ID`, `AWS_REGION`, `SESSIONS_TABLE`, and `PHOTOS_BUCKET`. The photo bucket permits `http://localhost:5173` and `http://127.0.0.1:5173`, plus the configured HTTPS domain.

## Validation and live checks

```powershell
npm test
npm run build:aws
cd backend
go test ./...
cd ../infra
go test ./...
pulumi preview
```

After deployment, verify `/api/health`, `/api/cloud`, signup/email verification, and a real Gemma image request. On phone and laptop, open the same session, upload on both, change a category, test delete-versus-edit conflict, restore Trash, shred, and export both formats. Automated tests use mocked provider/storage responses; real AWS permissions, quotas and model latency require a deployed smoke test.

## References

- https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-4-e2b.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-security.html
- https://www.pulumi.com/docs/iac/operations/stack-management/using-a-diy-backend/
