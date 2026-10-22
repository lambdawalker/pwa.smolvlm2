# Deploy Little Lens to AWS

## What runs where

- CloudFront serves `https://audit.apexfission.com` with an ACM certificate issued in `us-east-1`. Cloudflare hosts DNS-only CNAME records for the site and certificate validation. HTTP requests for the app redirect to HTTPS. Without a configured custom domain, the stack also supports the included `*.cloudfront.net` certificate.
- Private S3 stores the Vite build, including WASM runtime files. Only this CloudFront distribution can read them through origin access control.
- `/api/*` goes to API Gateway HTTP API and an ARM64 Go Lambda. `GET /api/health` returns JSON. This is a public health endpoint; authentication is not implemented. Add authorization before adding private APIs.
- SmolVLM2 still downloads directly from Hugging Face and runs on the phone. Photos are never sent to AWS. Moving hosts means the browser has a new origin/cache and will download the model again.
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

Both launchers work when invoked from another directory. The wizard itself is written in Go. It checks installed tools, displays your AWS account, selects or creates a Pulumi stack, prompts for region and hostname (default `audit.apexfission.com`), verifies Cloudflare access, builds and tests the app, then runs a Pulumi preview. **Type DEPLOY only after reviewing the preview** to create/update resources. Rerun with the same stack to update or resume an interrupted deployment. Declining after preview leaves local config/build artifacts but does not deploy resources.

Before running it:

1. Authenticate to AWS, for example `aws sso login --profile YOUR_PROFILE`. Enter that profile in the wizard. An empty profile uses your current credential chain.
2. Create a Cloudflare API token with **Zone → Zone → Read** and **Zone → DNS → Edit**, limited to **apexfission.com**. The account ID in the dashboard URL is not the zone ID; the wizard discovers the zone ID through the API.
3. Paste the token into the wizard's hidden prompt. Alternatively, supply `CLOUDFLARE_API_TOKEN` in your local environment. The token is passed to the Pulumi Cloudflare provider through the environment, not saved in source, stack config, or command-line arguments. Supply it again for future deployments or destroys. Avoid entering it in chat or committed files.
4. Log in to your Pulumi backend when prompted. Pulumi Cloud is the default option; local or another backend can be selected. Retain the state and any encryption passphrase so future updates and cleanup work. AWS, Cloudflare, and Pulumi credentials are separate.

The Cloudflare record uses **DNS only** (gray cloud): CloudFront handles TLS and caching. Keep the ACM validation CNAME for automatic certificate renewal. Existing DNS records not managed by the selected stack stop the wizard; it never automatically takes over another site. If you intentionally want to adopt an existing CNAME, inspect it and import it into the selected stack before running the wizard:

```powershell
cd infra
pulumi import cloudflare:index/dnsRecord:DnsRecord site-dns ZONE_ID/RECORD_ID
```

Do not import an apex record or a record serving another application without planning the migration. Existing ACM validation records may similarly need importing as `certificate-dns` if ACM reuses a validation name.

Open the exported URL in Chrome on the phone. Test `https://audit.apexfission.com/api/health` for a JSON health response. Then test model download, a real photo description, and PWA installation. DNS, ACM validation, and CloudFront provisioning can take several minutes. HTTPS resolves secure-context restrictions, but WebGPU still depends on browser and GPU support.

## Manual deployment

From the repository root, after AWS/Pulumi authentication and setting `CLOUDFLARE_API_TOKEN` locally:

```powershell
npm ci
npm run build:aws
cd infra
go mod download
pulumi stack select --create dev
pulumi config set aws:region us-east-1
pulumi config set domain audit.apexfission.com
pulumi config set cloudflareZoneId YOUR_ZONE_ID
pulumi preview
pulumi up
pulumi stack output url
```

No AWS resources are created by `npm run build:aws`; `pulumi up` creates billable resources. The AWS region is configurable; the CloudFront certificate always uses `us-east-1`. Build scripts set the Linux/ARM64 target themselves; do not set GOOS globally.

## Update an existing deployment

The simplest update is `git pull` followed by the same launcher and stack. For manual updates, keep AWS and Cloudflare credentials available. From the repository root:

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

Provide the same AWS credentials and CLOUDFLARE_API_TOKEN used for deployment. This deletes the hosted app, backend, managed S3 objects, log group, ACM certificate, and managed Cloudflare DNS records. The bucket is not configured to force-delete unmanaged objects; remove any manually added objects if they prevent deletion. Only run `pulumi stack rm dev` after successful destruction. Browser model caches are independent and are not removed by destroying the stack.

## Implementation references

- https://www.pulumi.com/registry/packages/aws/api-docs/cloudfront/originaccesscontrol/
- https://www.pulumi.com/registry/packages/aws/api-docs/apigatewayv2/integration/
- https://docs.aws.amazon.com/lambda/latest/dg/golang-package.html
