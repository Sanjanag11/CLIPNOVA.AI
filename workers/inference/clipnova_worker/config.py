from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    token: str | None
    allow_anon: bool
    data_dir: Path
    max_queue: int
    ttl_seconds: int

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            token=os.environ.get("WORKER_TOKEN") or None,
            allow_anon=os.environ.get("WORKER_ALLOW_ANON") == "1",
            data_dir=Path(os.environ.get("WORKER_DATA_DIR", "/tmp/clipnova-worker")),
            max_queue=int(os.environ.get("WORKER_MAX_QUEUE", "8")),
            ttl_seconds=int(os.environ.get("WORKER_TTL_SECONDS", "3600")),
        )
