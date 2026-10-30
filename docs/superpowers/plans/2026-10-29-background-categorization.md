# Background Categorization Implementation Plan

**Goal:** Upload completion automatically queues categorization, independent of browser lifetime; replace batch controls with per-photo Retry/Reclassify.

**Architecture:** A photo update and immutable job are committed in one DynamoDB transaction. DynamoDB Streams dispatches jobs to SQS; a separate Lambda processes them. Conditional revisions, leases, and photo job IDs prevent duplicate delivery and late results from overwriting edits or deletions. A scheduled recovery pass resends stalled durable jobs.

**Stack:** Go, DynamoDB Streams, SQS, Lambda, Amazon Bedrock, Pulumi Go, existing PWA.

## Constraints and review focus
- Store consent and the exact prompt with each job; never process photos without recorded consent.
- Queue visibility 360 seconds, worker timeout 60 seconds, lease 90 seconds, at most three application attempts, two concurrent workers by default.
- Duplicate delivery must not invoke the model twice after a result was committed.
- Shredding, Trash, manual edits and newer jobs supersede late results.
- Incoming UI results still require a cloud-button sync; background checks only indicate updates.
- Keep failed upload recovery, SHA-256/dHash indexing, document export and Spanish UI.

## Tasks
- [x] Add durable job model, atomic photo/job storage and bounded recovery scan; test transactional creation and preservation of account ownership.
- [x] Add stream dispatcher and SQS worker; test duplicates, transient/permanent failures, lease expiry, stale results, malformed model JSON and Trash/shredding.
- [x] Provision queue, dead-letter queue, stream mappings, worker, permissions and logs in Pulumi; test timeout/concurrency/visibility and least-scoped resources.
- [x] Persist upload processing settings and per-photo reclassification requests; test consent, immutable prompt, retries and idempotence.
- [x] Remove browser batch inference and start/stop/restart controls; add queued/processing/error labels and per-photo actions, preserving manual sync and all photo management.
- [x] Update local development guidance, docs, run npm/Go/Pulumi tests and production build; publish to main.
