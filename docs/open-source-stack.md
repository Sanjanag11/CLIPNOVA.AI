# Open-source stack for every purpose (licences checked where noted)

"Verified" = read from the project's own page or licence file (GitHub in the first research pass on 4 Nov 2026; Hugging Face model
cards and licence files through the Hugging Face connector on 6 Nov 2026). "Unverified" = from
secondary sources or memory: **read the licence on the model card before shipping a paid product.** Hugging Face and some
other hosts were not reachable from the research environment, so several model-card licences could not be opened.

| Purpose | Open-source choice | Licence | Status in this repo |
|---|---|---|---|
| Video: text to video | **Wan 2.2 TI2V-5B** | Apache-2.0 (verified: GitHub README and the Hugging Face card of `Wan-AI/Wan2.2-TI2V-5B-Diffusers`) | worker pipeline written, GPU-untested |
| | **LTX-Video** | **Two licences by version (verified on the model repo, see "LTX-Video licence" below).** v0.9.6 and newer: free below $10M annual revenue. Older v0.9.x: RAIL-M. | worker pipeline written, GPU-untested; loads an OLDER version, see below |
| | **CogVideoX-2B** | Apache-2.0 (verified on the Hugging Face card, now `zai-org/CogVideoX-2b`); the 5B model needs registration and is free to 1M visits/month (verified, MODEL_LICENSE) | worker pipeline written, GPU-untested |
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

## LTX-Video licence (read from the Hugging Face repo `Lightricks/LTX-Video`, 6 Nov 2026)
The repo's licence tag is just "other"; the real terms are in files inside it.
- **v0.9.6 and newer ("LTXV Open Weights License 0.X", 15 Apr 2025):** free for any purpose **if your annual revenue is below $10,000,000**.
  At or above $10M you must buy a commercial licence from Lightricks (ltxv-licensing@lightricks.com); using it without one is a breach with
  liquidated damages of double the fee. Hosting it as a service for third parties (SaaS) is allowed.
- **Conditions that become product requirements:**
  1. Your user terms must pass on the use restrictions in Attachment A, and you must give users a copy of the licence.
  2. Generated content must be clearly disclosed as machine-generated (Attachment A(e)). Paid-plan videos have no visible watermark, so they need another
     disclosure (file metadata, a caption, or terms the user accepts). **Not built yet.**
  3. No impersonating real people without consent (deepfakes), no harming minors, no false or defamatory content, no use for legal/medical/law-enforcement decisions.
  4. Lightricks may remotely restrict or update the model (section 6), and you should use the latest version.
- **Older versions (v0.9, v0.9.1, v0.9.5):** each has its own file. v0.9.1 is a RAIL-M licence dated 22 Nov 2024 (read in part). v0.9 and v0.9.5 were not read in full.
- **What our worker loads today:** `LTXPipeline.from_pretrained("Lightricks/LTX-Video")` loads the repo's top-level `transformer/` folder, which carries diffusers
  version 0.32.0.dev0 (late 2024), i.e. an **older v0.9.x model under the RAIL-M licence, not the newest**. The repo also holds newer, better checkpoints
  (e.g. `ltxv-2b-0.9.8-distilled`, 6.3 GB, and an fp8 version, 4.5 GB; Lightricks describes the 2B distilled as the light-VRAM option). Switching to one
  needs a code change and a GPU test (loading from a single file), so it has **not** been done.
- **Decision for you:** the older RAIL-M versions and the newer revenue-threshold licence both allow commercial use for a business of your size today. If ClipNova
  grows past $10M in annual revenue, a paid LTX licence (or another model) is needed. Wan 2.2 and CogVideoX-2B (both Apache-2.0) have no such limit.
- Not legal advice: have a lawyer read it before a public launch.
