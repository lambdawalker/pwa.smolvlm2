# Little Lens · SmolVLM2 PWA

A mobile-first, installable photo describer. Pick a photo from the Android/iOS system gallery and describe it **on device** with `HuggingFaceTB/SmolVLM2-256M-Video-Instruct`. No server inference, uploads, account, analytics, or API key.

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

1. Choose one photo (gallery picker; no forced camera capture).
2. Pick a description style and tap **Describe photo**.
3. First use downloads model files, with per-file progress. Typical model assets are approximately 321 MB with shader-f16 or 575 MB without it, plus runtime/configuration overhead; reserve roughly 350–650 MB. This is ONNX, not the earlier SmolVLM TFLite conversion.
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
- Model weights/configuration are pinned to revision `067788b187b95ebe7b2e040b3e4299e342e5b8fd` for reproducible downloads.

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
