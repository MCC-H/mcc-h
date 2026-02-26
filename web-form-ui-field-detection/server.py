#!/usr/bin/env python3
"""
Form UI field detection server using foduucom/web-form-ui-field-detection (YOLOv8).
Receives form/screenshot images (base64), returns detected field boxes.
Run: ./setup_env.sh then ./run.sh
"""
import base64
import io
import os
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify
from PIL import Image
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).parent
WEIGHTS_DIR = SCRIPT_DIR / "weights"
REPO_ID = "foduucom/web-form-ui-field-detection"

# Fix typos in model class names (foduucom model has "redio button")
CLASS_NAME_FIXES = {"redio button": "radio button"}
# IoU threshold for filtering overlapping same-class detections
IOU_THRESHOLD = 0.5


def _iou(box1: list, box2: list) -> float:
    """Intersection over Union of two boxes [x1,y1,x2,y2]."""
    x1 = max(box1[0], box2[0])
    y1 = max(box1[1], box2[1])
    x2 = min(box1[2], box2[2])
    y2 = min(box1[3], box2[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
    area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
    union = area1 + area2 - inter
    return inter / union if union > 0 else 0


def filter_overlapping(detections: list) -> list:
    """Remove overlapping detections of the same class, keeping higher-confidence."""
    by_class = {}
    for d in detections:
        cls = d["class"]
        by_class.setdefault(cls, []).append(d)
    out = []
    for cls, items in by_class.items():
        items = sorted(items, key=lambda x: x["confidence"], reverse=True)
        keep = []
        for d in items:
            bbox = d["bbox"]
            if any(_iou(bbox, k["bbox"]) > IOU_THRESHOLD for k in keep):
                continue
            keep.append(d)
        out.extend(keep)
    return out


app = Flask(__name__)

model = None


def get_model_path():
    """Find local .pt file or use HF repo id."""
    if WEIGHTS_DIR.exists():
        for f in WEIGHTS_DIR.rglob("*.pt"):
            return str(f)
    return REPO_ID


def load_model():
    global model
    if model is not None:
        return
    path = get_model_path()
    print(f"[web-form-ui] Loading model from {path}...")
    model = YOLO(path)
    print("[web-form-ui] Model loaded")


@app.route("/")
def index():
    html = (SCRIPT_DIR / "index.html").read_text(encoding="utf-8")
    return html


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/classes", methods=["GET"])
def classes():
    """Return model class names (id -> name)."""
    load_model()
    return jsonify({"classes": model.names})


@app.route("/detect", methods=["POST"])
def detect():
    """POST /detect with JSON body: {"images": ["base64...", "base64..."]}
    Returns: {"detections": [[{class, confidence, bbox: [x1,y1,x2,y2]}, ...], ...]}
    """
    load_model()
    data = request.get_json()
    if not data or "images" not in data:
        return jsonify({"error": "Missing images array"}), 400
    images_b64 = data["images"]
    if not isinstance(images_b64, list):
        return jsonify({"error": "images must be an array"}), 400

    results_out = []
    for b64 in images_b64:
        try:
            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            fd, img_path = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            img.save(img_path)
        except Exception as e:
            results_out.append({"error": str(e), "detections": []})
            continue

        try:
            results = model.predict(img_path, conf=0.03, verbose=False)
            detections = []
            for r in results:
                if r.boxes is not None:
                    for box in r.boxes:
                        xyxy = box.xyxy[0].tolist()
                        cls_id = int(box.cls[0])
                        raw = model.names.get(cls_id, f"class_{cls_id}")
                        cls_name = CLASS_NAME_FIXES.get(raw, raw)
                        conf = float(box.conf[0])
                        detections.append({
                            "class": cls_name,
                            "confidence": round(conf, 4),
                            "bbox": [round(x, 2) for x in xyxy],
                        })
            detections = filter_overlapping(detections)
            results_out.append({"detections": detections})
        except Exception as e:
            results_out.append({"error": str(e), "detections": []})
        finally:
            try:
                os.unlink(img_path)
            except OSError:
                pass

    return jsonify({"results": results_out})


def main():
    load_model()
    port = int(os.environ.get("PORT", 5901))
    print(f"[web-form-ui] Listening on port {port}")
    app.run(host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
