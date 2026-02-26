#!/usr/bin/env python3
"""Download OmniParser icon_caption from HuggingFace."""
import os
import shutil
from pathlib import Path

from huggingface_hub import snapshot_download

SCRIPT_DIR = Path(__file__).parent
WEIGHTS_DIR = SCRIPT_DIR / "weights"
ICON_CAPTION_DIR = WEIGHTS_DIR / "icon_caption"

if ICON_CAPTION_DIR.exists() and (ICON_CAPTION_DIR / "model.safetensors").exists():
    print(f"icon_caption already exists at {ICON_CAPTION_DIR}")
    exit(0)

WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
print("Downloading OmniParser icon_caption (~1.1 GB)...")
snapshot_download(
    repo_id="microsoft/OmniParser-v2.0",
    allow_patterns=["icon_caption/*"],
    local_dir=str(WEIGHTS_DIR),
    local_dir_use_symlinks=False,
)
src = WEIGHTS_DIR / "OmniParser-v2.0" / "icon_caption"
if src.exists():
    if ICON_CAPTION_DIR.exists():
        shutil.rmtree(ICON_CAPTION_DIR)
    shutil.move(str(src), str(ICON_CAPTION_DIR))
    try:
        (WEIGHTS_DIR / "OmniParser-v2.0").rmdir()
    except OSError:
        pass
print(f"Done. Model at {ICON_CAPTION_DIR}")
