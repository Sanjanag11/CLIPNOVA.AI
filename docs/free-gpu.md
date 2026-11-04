# Running the models for free (or nearly)

The model **weights** are free and open source. The **GPU** to run them is the only real cost. Free options exist, with limits.
Figures below come from third-party summaries found in a web search on 4 Nov 2026 and are approximate; check each provider.

| Option | What you get (approx.) | Good for | Watch out |
|---|---|---|---|
| **Modal** free monthly credit | about $30 of compute per month on the Starter plan; billed per second, nothing while idle; third-party estimates say roughly 27 T4-hours or ~7 H100-hours of credit | the best free start: a real HTTPS endpoint with a proper GPU (L4/A10G/L40S 24 GB+ serves all three models) | credit is small; check modal.com/pricing for current rates and plan terms |
| **Kaggle notebooks** | commonly cited ~30 GPU-hours/week on a T4 or P100, 12 h sessions (Kaggle does not publish the number) | trying LTX-Video and CogVideoX; batch-making demo clips | a T4 has 16 GB and no bf16: **Wan 2.2 is not served**; sessions end, so no stable URL; read Kaggle's terms before exposing a tunnel |
| **Google Colab (free)** | a T4 when available, no published quota | quick experiments | no guaranteed GPU; Colab restricts some uses such as serving; development only |
| **Your own GPU** | RTX 3090/4090 (24 GB) serves all three | unlimited local use | you need the hardware |

Free notebooks are for **development**, not for serving real users: they stop without warning and have no stable address.

## Kaggle / Colab recipe (untested)
```bash
# in a notebook cell, GPU on, internet on
!git clone <your repo> && cd CLIPNOVA.AI/workers/inference && pip install -q -e ".[gpu]"
import os; os.environ["WORKER_TOKEN"] = "<long random string>"
!nohup python -m clipnova_worker > worker.log 2>&1 &
# a free public URL without an account:
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared && chmod +x cloudflared
!./cloudflared tunnel --url http://localhost:8000      # prints https://<random>.trycloudflare.com
```
Then run the web app with `CLIPNOVA_WORKER_URL=https://<random>.trycloudflare.com` and the same `CLIPNOVA_WORKER_TOKEN`.
`tail worker.log` shows which models it decided to serve and why it skipped others.
