#!/usr/bin/env python3
"""Download foduucom/web-form-ui-field-detection from HuggingFace."""
import os
from pathlib import Path

from huggingface_hub import snapshot_download

SCRIPT_DIR = Path(__file__).parent
WEIGHTS_DIR = SCRIPT_DIR / "weights"
REPO_ID = "foduucom/web-form-ui-field-detection"

# Check for best.pt or model.pt (YOLO format)
def has_model():
    if not WEIGHTS_DIR.exists():
        return False
    for name in ("best.pt", "model.pt", "weights/best.pt"):
        if (WEIGHTS_DIR / name).exists():
            return True
    # snapshot_download puts files at root
    for f in WEIGHTS_DIR.iterdir():
        if f.suffix == ".pt":
            return True
    return False

if has_model():
    print(f"Model already exists at {WEIGHTS_DIR}")
    exit(0)

WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
print(f"Downloading {REPO_ID}...")
snapshot_download(
    repo_id=REPO_ID,
    local_dir=str(WEIGHTS_DIR),
    local_dir_use_symlinks=False,
)
print(f"Done. Model at {WEIGHTS_DIR}")
