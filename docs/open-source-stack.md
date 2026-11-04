# Open-source stack for every purpose (licences checked where noted)

"Verified" = read from the project's own page or licence file in this project's research (4 Nov 2026). "Unverified" = from
secondary sources or memory: **read the licence on the model card before shipping a paid product.** Hugging Face and some
other hosts were not reachable from the research environment, so several model-card licences could not be opened.

| Purpose | Open-source choice | Licence | Status in this repo |
|---|---|---|---|
| Video: text to video | **Wan 2.2 TI2V-5B** | Apache-2.0 (verified, repo README) | worker pipeline written, GPU-untested |
| | **LTX-Video** | checkpoint licence **unverified** (newer LTX-2.x has a revenue-threshold community licence) | worker pipeline written, GPU-untested |
| | **CogVideoX-2B** | Apache-2.0 (verified); the 5B model needs registration and is free to 1M visits/month (verified, MODEL_LICENSE) | worker pipeline written, GPU-untested |
| | Mochi 1 (10B, ~60 GB GPU) | Apache-2.0 (verified) | not integrated (too large for free GPUs) |
| | Open-Sora 2.0 (11B) | Apache-2.0 (verified); 768px takes ~28 min on one H100 | not integrated (too slow) |
| | LongCat-Video (13.6B) | MIT (verified) | not integrated; candidate for 12-30 s videos |
| | HunyuanVideo 1.5 | Tencent licence **excludes EU, UK, South Korea** (verified) | not integrated; routing already blocks those regions |
| | Stable Video Diffusion XT | Stability community licence, free under $1M revenue (search summary; SVD-XT 1.1 name unclear) | not integrated; image-to-video only |
| Video: image / video input | Wan 2.2 I2V, VACE (Apache-2.0 for the Wan variants, verified), LTX IC-LoRA | see above | blocked on stored uploads (not built) |
| Assembly, watermark, shapes | **ffmpeg** | LGPL/GPL (use the system binary) | done and tested |
| Frame-rate smoothing (CogVideoX is 8 fps) | ffmpeg `minterpolate` today; RIFE later | RIFE: unverified | frames are duplicated to 24 fps for now |
| Planner (story to scenes) | today: deterministic splitter. Open LLM later (e.g. Qwen or Llama via vLLM/Ollama) | **unverified**; Indic-language quality must be benchmarked | not built |
| Hindi/Marathi/etc. to English prompts | **IndicTrans2** (AI4Bharat) | **unverified** | hook exists (`translate` option on the adapter) |
| Voiceover (Indic) | **Indic Parler-TTS** (AI4Bharat) | **conflicting sources** (Apache-2.0 / MIT / "gated"); confirm with AI4Bharat | not built |
| | Piper, Kokoro | permissive (unverified); limited Indic coverage | not built |
| | Coqui XTTS, Meta MMS-TTS | **non-commercial** (unverified) | do not use |
| Captions timing | **Whisper / WhisperX** | MIT / BSD (unverified) | not built |
| Music | **ACE-Step** (newer releases) | **conflicting**: MIT/Apache for newer, CC BY-NC for older | not built |
| | MusicGen weights, Stable Audio Open | **non-commercial / revenue-limited** | do not use for paid output |
| Safety classifiers | open NSFW image classifiers, Llama Guard | **unverified** | not built; moderation is currently OFF |

Until audio exists, the live engine does not charge for voiceover, music or sound effects (tested).
