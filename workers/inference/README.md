# ClipNova inference worker

Serves open-source video models over a small HTTP API. The web app never runs models; it sends jobs here.

| Model | Offered when | Output | Status |
|---|---|---|---|
| Wan 2.2 TI2V-5B (Apache-2.0) | GPU has >= 24 GB and bf16 (A10G, L4, L40S, A100, 4090...) | up to 5 s, 1280x704 / 704x1280, 24 fps | written from the diffusers docs, **not run on a GPU** |
| LTX-Video | GPU has >= 12 GB | up to 5 s, 768x512 / 512x768, 24 fps | written from the diffusers docs, **not run on a GPU** |
| CogVideoX-2B (Apache-2.0) | GPU has >= 6 GB | 6 s, 720x480 landscape only, 8 fps | written from the diffusers docs, **not run on a GPU** |

Only text-to-video is offered. Image-to-video for Wan TI2V-5B is not documented in diffusers, and the app cannot store
uploaded images yet. A model that does not fit the detected GPU is **not served** (a free 16 GB T4 serves LTX and CogVideoX, not Wan).

## Test the models on a free GPU (start here)
Open `notebooks/test_models.ipynb` in Google Colab or Kaggle (turn the GPU on), run the cells, and watch one clip per model.
Or, on any machine with a GPU: `pip install -e ".[gpu]" && python -m clipnova_worker.smoke` (no server, no web app).
`--fake` checks the plumbing without a GPU.

## Run without a GPU (development and tests)
```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest                      # 75 tests, real ffmpeg
WORKER_FAKE=1 WORKER_TOKEN=dev-token .venv/bin/python -m clipnova_worker
# then in the web app: CLIPNOVA_WORKER_URL=http://localhost:8000 CLIPNOVA_WORKER_TOKEN=dev-token
```
`WORKER_FAKE=1` declares the real capabilities but renders ffmpeg test patterns, so you can exercise the whole product.

## Run on a GPU
```bash
pip install -e ".[gpu]"
WORKER_TOKEN=<long random string> python -m clipnova_worker     # logs which models it serves and why others are skipped
```
The first job downloads the weights from Hugging Face (several GB per model).

## Deploy
- **Modal** (recommended; GPU billed per second, scales to zero): `modal_app.py`. Untested, see its header.
- **Free notebooks** (Kaggle / Colab): see `docs/free-gpu.md`.

## Settings (environment)
| Variable | Meaning |
|---|---|
| `WORKER_TOKEN` | Bearer token the web app must send. The worker refuses to start without it (or `WORKER_ALLOW_ANON=1`, local only). |
| `WORKER_MODELS` | Comma list of model ids to offer (default: all three). |
| `WORKER_FAKE` | `1` = fake rendering, no GPU needed. |
| `WORKER_IGNORE_VRAM` | `1` = offer models even if the GPU looks too small (may run out of memory). |
| `WORKER_MAX_QUEUE`, `WORKER_TTL_SECONDS`, `WORKER_DATA_DIR`, `PORT` | queue length (429 when full), how long finished videos are kept, scratch directory, port. |

## Protocol (the web app's `HttpVideoAdapter` is the client; change both together)
Whole videos (used by the web app): `POST /v1/videos {model, aspectRatio, watermark, seed?, scenes:[{prompt, seconds}]}` -> `202 {videoId}` |
`GET /v1/videos/{id}` -> `{status, progress, gpuSeconds, scenes:[{index,state,progress,attempt,revision,error?}], regens, error?}` |
`GET /v1/videos/{id}/video` | `POST /v1/videos/{id}/scenes/{i}/regenerate {prompt?, seed?}` -> `202 {regenId}` | `DELETE /v1/videos/{id}`.

Single clips (used by the smoke test and the core `HttpVideoAdapter`): `GET /healthz` | `GET /v1/models` | `POST /v1/jobs {model, prompt, negativePrompt?, seconds, aspectRatio, seed?, steps?}` -> `202 {jobId}` |
`GET /v1/jobs/{id}` -> `{status, progress, gpuSeconds, error?{code,message,retryable}}` | `GET /v1/jobs/{id}/video` | `DELETE /v1/jobs/{id}`.
Errors: `401` bad token, `404` unknown model/job, `422` request the model cannot do, `429` queue full, `409` video not ready.
An out-of-memory failure is reported `retryable: false` so the app moves on to a lighter model instead of repeating it.
