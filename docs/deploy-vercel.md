# Deploy the private test on Vercel (app) + Modal (GPU) with one free open-source model

```
Browser ──> Vercel (web app + API) ──> Neon Postgres   (credits, videos, ratings)
                 │                 └──> Vercel Blob    (finished videos)
                 └──────────────────> Modal GPU worker (LTX-Video, started only while a video renders)
```
Vercel cannot run the video model (no GPU, short-lived functions), so the GPU lives on Modal and Vercel just hands it jobs
and checks on them. Everything the app remembers is in the database, because Vercel forgets everything between requests.

**Status:** the app, the database layer, the access gate and the worker protocol are tested end to end locally
(real Python worker + real browser). **Not tested** because they need your accounts: the Vercel deployment itself, Neon,
Vercel Blob, Modal, and the real LTX-Video model on a GPU. Expect to fix small things on the first deploy.

## Costs and limits (approximate; check each site, they change)
| Piece | Free allowance | Caveat |
|---|---|---|
| Vercel Hobby | free | Functions are capped at about 5 minutes (our requests take seconds). Hobby is meant for personal, non-commercial use; a business launch needs a paid plan (check Vercel's terms). |
| Neon Postgres (via Vercel Marketplace) | free tier | tiny databases only; confirm current limits when you create it |
| Vercel Blob | small free allowance | each video is a few MB; confirm current limits |
| Modal | about $30 of compute credit per month | billed per second; set a **spending limit** in the Modal dashboard. First video downloads the model (several GB) and is slow. |

## Part 1: the GPU worker on Modal (LTX-Video only)
1. Create a free account at modal.com.
2. Make a long random token (this is the password between Vercel and the worker). In any Python: `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Keep it; you will paste it twice.
3. In the Modal dashboard: **Secrets -> Create secret -> Custom**, name it exactly `clipnova-worker`, add one key `WORKER_TOKEN` with your token.
4. Deploy. Easiest without installing anything locally: a Google Colab notebook (no GPU needed for this step):
   ```python
   !pip install -q modal
   import getpass, os, subprocess
   # modal.com -> Settings -> API tokens -> create one, then paste both values when asked
   os.environ["MODAL_TOKEN_ID"] = getpass.getpass("Modal token id: ")
   os.environ["MODAL_TOKEN_SECRET"] = getpass.getpass("Modal token secret: ")
   token = getpass.getpass("GitHub token (read access to CLIPNOVA.AI): ")
   subprocess.run(["git", "clone", "--depth", "1", "--branch", "feat/m1-foundation", f"https://{token}@github.com/Sanjanag11/CLIPNOVA.AI.git"])
   os.chdir("CLIPNOVA.AI/workers/inference")
   !modal deploy modal_app.py
   ```
   (Or on a computer with Python: `pip install modal && modal setup && modal deploy modal_app.py` inside `workers/inference`.)
5. The output ends with a web address like `https://<you>--clipnova-worker-serve.modal.run`. Open `<that address>/healthz`. You should see `{"ok":true}`. (The first visit can take a minute: the GPU container is starting.)

`modal_app.py` serves only LTX-Video by default. To change the GPU: set `CLIPNOVA_GPU` before deploying (default `L4`).

## Part 2: Vercel
1. vercel.com -> **Add New -> Project** -> import the `CLIPNOVA.AI` GitHub repository (allow Vercel to read the private repo).
2. **Root Directory:** `apps/web`. Leave "Include source files outside of the Root Directory" **on** (the app uses `packages/core`).
3. **Production branch:** this work is on `feat/m1-foundation`. Either set that as the production branch (Settings -> Git) or merge it into `main` first.
4. Before deploying, open the project's **Storage** tab:
   - create a **Postgres** database (Neon, from the Marketplace) and connect it to the project;
   - create a **Blob** store and connect it.
   Connecting adds `DATABASE_URL` (or `POSTGRES_URL`) and `BLOB_READ_WRITE_TOKEN` for you.
5. **Settings -> Environment Variables** (Production), add:
   | Name | Value |
   |---|---|
   | `CLIPNOVA_WORKER_URL` | the Modal address from Part 1 (no trailing slash) |
   | `CLIPNOVA_WORKER_TOKEN` | the token from Part 1, step 2 |
   | `CLIPNOVA_WORKER_MODELS` | `ltx` |
   | `CLIPNOVA_ACCESS_CODE` | a code of **10+ characters** you will share with testers |
   | `CLIPNOVA_DEMO` | `1` |
6. **Deploy.** Open the address Vercel gives you. You should see the access-code page; enter your code; you land on Create.

Safety by design: if `CLIPNOVA_ACCESS_CODE` is missing (or under 10 characters) while a worker is attached, the site refuses **everyone** with a 503, so it can never be left open to the internet by mistake.

## Part 3: test it
1. Create -> Plan my video -> Generate. The first video after the GPU has been idle can take several minutes (the container starts and the model loads); later ones are faster.
2. You should see real progress, then a playing video with a working Download button.
3. Regenerate one scene; only that scene's credits are used.
4. Check the credits box in the top right goes down by the quoted amount (24 for 8 s).
5. Stop the Modal app mid-video (Modal dashboard) and watch the video fail with the credits returned.

Testers share the demo credits of the plan chosen in the address bar (`/create?plan=free|creator|pro`). There is no sign-in yet.

## What this test does NOT include
Only Text to Video with LTX-Video (image and video modes say "Not available yet"); no audio; no safety/moderation checks;
no sign-in, payments or per-user accounts; the Library, Model Lab and Admin screens still show the prototype's sample data.
LTX-Video's licence must be verified on its model card before any public launch.

## If something goes wrong
| You see | Likely cause |
|---|---|
| Plan button disabled / "Couldn't get the price" | the app can't reach its database or the worker: check `DATABASE_URL` and `CLIPNOVA_WORKER_URL` in Vercel, then the deployment logs |
| "The video service is busy or offline. You were not charged." | the worker is starting (wait and retry), or the URL/token is wrong |
| Video fails with `WORKER_LOST_JOB` | the Modal container restarted mid-video; credits are returned; try again |
| Video fails with `OOM` | the GPU ran out of memory: use a larger GPU (`CLIPNOVA_GPU=L40S`) and redeploy |
| 503 "access code has not been configured" | set `CLIPNOVA_ACCESS_CODE` (10+ characters) |
| 501 "Sign-in is not available yet" | set `CLIPNOVA_DEMO=1` |
