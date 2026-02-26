#!/usr/bin/env python3
"""Export foduucom/web-form-ui-field-detection to CoreML (.mlpackage).
Run on macOS: ./export_coreml.sh or conda run -n web-form-ui-field-detection python export_coreml.py
Requires: coremltools (pip install coremltools)
"""
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
OUTPUT_PATH = SCRIPT_DIR / "weights" / "web-form-ui-field-detection.mlpackage"


def main():
    if sys.platform != "darwin":
        print("[export_coreml] CoreML export requires macOS. Skipping.")
        return 1

    try:
        import coremltools
    except ImportError:
        print("[export_coreml] Install coremltools: pip install coremltools")
        return 1

    from ultralytics import YOLO

    model_path = "foduucom/web-form-ui-field-detection"
    weights = SCRIPT_DIR / "weights"
    if weights.exists():
        for f in weights.rglob("*.pt"):
            model_path = str(f)
            break

    print(f"[export_coreml] Loading {model_path}...")
    model = YOLO(model_path)
    print("[export_coreml] Exporting to CoreML...")
    out = model.export(
        format="coreml",
        nms=True,
        imgsz=640,
        half=False,
    )
    out_path = Path(out)
    if out_path.exists():
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        if OUTPUT_PATH.exists():
            shutil.rmtree(OUTPUT_PATH)
        shutil.copytree(out_path, OUTPUT_PATH)
        print(f"[export_coreml] Saved to {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
