# Little Lens · SmolVLM2 PWA

A mobile-first, installable photo categorizer and describer. Pick a photo from the Android/iOS system gallery and describe it **on device** with a choice of five vision models. No server inference, uploads, account, analytics, or API key.

## Run

Node.js 22.12+ (or 24) is required.

```sh
npm ci
npm run build
npm run preview
```

Open the localhost URL. For development, run `node scripts/assets.mjs` then `npm run dev`. A physical phone needs an **HTTPS** host: ordinary HTTP over a LAN IP does not enable WebGPU or service workers. Desktop localhost is a secure-context exception.

## GitHub Pages

In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**, then run the **Build and deploy PWA** workflow. The workflow also builds and tests pull requests without deploying them. Its production base path is `/pwa.smolvlm2/`.

Expected URL after a successful deployment: https://lambdawalker.github.io/pwa.smolvlm2/

For another static host, `npm run build` uses `/` by default. Set `BASE_PATH=/your-subpath/` when needed and serve `dist/` over HTTPS.

## Experience

1. Open **Download models**, choose a model, and wait for verification. Previously cached files are reused. Then open Categorize photos or Describe a photo; their selectors show only fully verified, downloaded models for your device.
2. Once the model is ready, tap **Continue to photos** and choose one photo (gallery picker; no forced camera capture).
3. Pick a description style, or choose **Custom prompt** and enter a question/instruction (up to 1,000 characters). Tap **Describe photo**.
4. Descriptions stream into the page. Cancel terminates the worker immediately, releasing its model; completed cached files are reused on retry.
5. Copy the result, change the photo, or remove it from the page.

English prompts/output are intentional: this tiny model is primarily English. Generated text can be inaccurate. It is not an OCR accuracy guarantee or an accessibility substitute without review. The model supports video, but this app intentionally accepts **still photos only**.

## Browser support and limitations

- Requires a working WebGPU adapter in the browser, not just an advertised GPU.
- Compatible Android Chrome browsers and iOS 26+ Safari are targets; support is detected before enabling inference. No silent CPU fallback or cloud upload.
- Mobile GPU drivers, available RAM, browser memory limits and model operators affect compatibility. A runtime error offers retry; close other tabs if memory is exhausted.
- Browser-decodable JPEG/PNG/WebP and other images are accepted. HEIC/HEIF only works when the browser can decode it; otherwise the UI asks for JPEG or a screenshot.
- Input file limit: 30 MB. Images are resized to a maximum 768-pixel edge, metadata is not sent to the model, and image splitting is disabled. Very large source photos can still require significant decoding memory.
- No photos or descriptions are persisted. They remain in memory until removed/replaced or the app closes.

## Offline and installation

The generated service worker precaches the app, worker and matching ONNX Runtime WASM assets. Transformers.js uses its `transformers-cache` Cache Storage cache for model/configuration files. Complete one online description before attempting offline use. Storage persistence is requested best-effort; the browser may deny it or evict caches. Offline readiness is not guaranteed merely by installing the PWA.

On Android, use the install button when offered or the browser menu. On iPhone, Share → Add to Home Screen. Installing does not bypass browser memory limits, and backgrounding may suspend inference. Updates wait for the user to reload; reload is disabled while a task is running. **Delete downloaded model** clears only Transformers.js's cache (shared by this origin), not the app shell.

## Implementation

- Vite + vanilla JavaScript, responsive CSS, no backend.
- Transformers.js 3.8.1 with `AutoModelForVision2Seq` and `AutoProcessor`.
- Dedicated module worker; WebGPU fp16 vision/embeddings + q4f16 decoder when available, otherwise fp32 vision/embeddings + q4 decoder.
- ONNX Runtime WASM/module files copied from the locked dependency at build time, served from the same origin.
- All model revisions are pinned in `src/models.js` for reproducible downloads.

## Validation

```sh
npm test
npm run build
# Optional: downloads processor/tokenizer configuration, not model weights
npm run test:model
```

Unit tests cover photo sizing, file validation, and recovery messages. `test:model` exercises the real pinned SmolVLM2 chat template and image processor, asserting the expected image tensor shape. Before claiming support for a device, perform the following manual acceptance checks on **real Android and iOS devices**:

- Pick a real gallery image, finish the model download, and obtain a relevant description.
- Confirm the network contains model downloads but no image uploads.
- Cancel during download and generation, retry, and switch images.
- Close/reopen offline and repeat inference after caches were populated.
- Try HEIC, unsupported files, low storage and GPU/memory failures.
- Install to home screen, verify launch/icon, then test an app update.

Build/unit checks do not prove model inference or performance on a phone.

## Attribution

SmolVLM2 by Hugging Face: https://huggingface.co/HuggingFaceTB/SmolVLM2-256M-Video-Instruct (Apache-2.0 model license). Transformers.js: https://github.com/huggingface/transformers.js (Apache-2.0). Model weights are downloaded from Hugging Face, not committed here. Dependencies retain their own licenses.

### Guided model setup

Open **Download models** to download or verify any of the five models. Each file has its own progress bar. A model becomes available after successful loading and verification that all requested files are in the browser cache. The receipt is tied to its pinned revision and device precision variant. Photo pages check every receipt file and use cached-only loading, so missing files require returning to the downloads page. Old caches from earlier app versions need one verification pass; existing files are reused. Delete cached files removes that model and its receipts. Browser storage eviction can make a model unavailable again.

## AWS deployment (Go + Pulumi)

See [the AWS deployment guide](docs/aws-deployment.md) for Windows-friendly setup, build, preview, deployment, updates, and cleanup. The stack provides CloudFront HTTPS + private S3 for the PWA and an API Gateway + Go Lambda backend at `/api/*`. Build everything with `npm run build:aws`, then deploy from `infra/` with Pulumi. Inference remains on the device.

Deploy to **audit.apexfission.com** using `.\deploy.bat` on Windows or `sh ./deploy.sh` on Linux/macOS. The Go wizard guides AWS/Pulumi authentication, Cloudflare DNS setup, builds, preview, and deployment confirmation. See the deployment guide for prerequisites and the scoped Cloudflare API token.

The wizard defaults to **S3-backed Pulumi state** with a private versioned bucket and AWS KMS secrets. It remembers non-secret setup in `.deploy/settings.json` and reuses the encrypted Cloudflare token. Subsequent runs skip setup questions; use `--configure` to review the saved defaults. The state bucket/key are prepared before the application preview and retained independently of the app.

## Available vision models

| Model | Approximate model download | Modes |
| --- | --- | --- |
| SmolVLM2 256M | 350–650 MB | Descriptions, custom prompts |
| SmolVLM2 500M | 550–900 MB | Descriptions, custom prompts |
| Original SmolVLM 500M | 550–900 MB | Descriptions, custom prompts |
| Florence-2 Base 230M (fine-tuned) | 450–850 MB | Short/detailed captions, OCR, object detection |
| Moondream2 (Xenova ONNX export) | 1.5–1.8 GB | Descriptions, custom prompts |

Estimates include some overhead and vary with shader-f16 support; these are downloads, not RAM requirements. Moondream2 is substantially larger and may exhaust phone memory. This is the pinned Xenova conversion, not a promise of features from newer Moondream releases.

Florence uses native task tokens and postprocessing instead of the chat prompt. Its outputs appear after generation (no token streaming); object detection displays JSON labels and bounding boxes in resized-photo pixel coordinates. Florence does not expose free-form chat prompts. Changing to a conversational model restores the description/custom-prompt controls.

Each model has a pinned revision and family-specific loading, preprocessing, and decoding. `npm run test:model` checks real processor/tokenizer inputs for all five without downloading model weights. Full WebGPU inference and memory limits still require testing on target phones.

## Batch categorization

The home page selects multiple images and uses **SmolVLM2 256M** to categorize them into Indoors, Outdoors, Documents, or Computer screens. When downloaded, the dropdown also offers SmolVLM2 500M, original SmolVLM 500M, and Moondream2. Florence-2 is omitted here because it does not support the free-form categorization prompt; it remains available on the description page. The batch selector defaults to 256M when downloaded, otherwise the first available model and is independent of the description page. Switching models releases the previous worker and keeps completed categories; only pending photos use the new selection. The selector is locked during processing—stop first to change models. Tap **Categorize photos** to restore the downloaded model and start.

Images are resized and processed sequentially on the device. Stop keeps completed results; continue processes the remaining photos. Failed files can be retried. Ambiguous model responses appear under Needs attention instead of being silently assigned a category. Each card has a category selector for corrections. Computer interfaces/screens take precedence over documents, and documents take precedence over indoor/outdoor scenes when they are the main subject.

Results and selected photos stay in memory for the current visit; refreshing clears them. No files are uploaded, moved, or changed in the phone gallery. Only small processed thumbnails are kept alongside the selected File references. Full-size decoded images are handled one at a time. Classification accuracy must be evaluated on your photos; the small model can misclassify them.

The previous single-photo experience, including all five model choices and custom prompts, is available at `describe.html` through **Describe a photo**. Both pages are included in the production build and service-worker precache.

## Dependency maintenance

`package.json` scopes two overrides to their upstream consumers: `onnxruntime-node` uses `global-agent` 4.1.3 to remove the abandoned `boolean` dependency, and `workbox-build` uses `glob` 13.0.6 instead of deprecated glob 11. The ONNX runtime and Transformers.js versions are unchanged. Keep `package-lock.json` committed and use `npm ci` for reproducible installs. Revisit these overrides when upgrading the parent packages. These overrides address the deprecation warnings; they do not resolve every finding reported by `npm audit`.

### Model download progress

Both pages show one progress bar per requested file. Model transfers are limited to three at once, with slots held until the response body finishes. Files already queued are started smallest-first using size metadata for the pinned Hugging Face revision; unknown sizes go last. Configuration dependencies can introduce files later, so this is a priority order among ready requests, not a global ordering of every model file. Cached files are reused without network transfers. If size metadata is unavailable, loading still works with the three-transfer limit. Stopping terminates the worker and its pending downloads.

### Prompt editing and raw output

The categorization prompt can be edited before starting a batch (up to 1,000 characters), or restored with Reset prompt. The chosen text is fixed for that run; editing is locked while processing. Each processed photo card displays the model's text output before category parsing, including responses that require manual review. Manual category corrections do not alter that output.

### SmolVLM image resizing check

The app already downsizes photos proportionally to a maximum 768-pixel edge without upscaling. The pinned SmolVLM processors run with `do_image_splitting: false`. Running `node scripts/check-resizing.mjs` on all three SmolVLM variants with 256×192, 512×384, 768×576, and 1536×1152 synthetic images produced the same `[1, 1, 3, 512, 512]` pixel tensor and 79 prompt tokens in every case. This verifies processing shape, not classification accuracy or phone latency.

The existing resize reduces the image data sent to the worker and its decoding work, but reducing it further does not reduce the model's input tensor in this mode and can discard detail. We retain the 768-pixel cap. Evaluating quality changes or enabling image splitting requires representative labeled photos and phone benchmarks. Hugging Face documents resizing and splitting at https://huggingface.co/docs/transformers/main/model_doc/smolvlm.
