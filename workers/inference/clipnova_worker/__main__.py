"""python -m clipnova_worker  ->  serves on 0.0.0.0:8000 (override with PORT)."""
import logging
import os

import uvicorn

from .app import create_app
from .registry import build_registry

logging.basicConfig(level=logging.INFO)
registry = build_registry()
print("serving models:", ", ".join(registry) or "NONE (see warnings above)")
uvicorn.run(create_app(registry), host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8000")))
