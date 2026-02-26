#!/usr/bin/env python3
"""
Icon caption server using OmniParser icon_caption (Florence 2).
Receives cropped icon images (base64), returns captions.
Run: ./setup_env.sh then ./run.sh
"""
import base64
import io
import os
from pathlib import Path

from flask import Flask, request, jsonify
from PIL import Image
import torch
from transformers import AutoModelForCausalLM

# Use Florence2Processor directly to avoid AutoProcessor config.get bug in newer transformers
try:
    from transformers.models.florence2 import Florence2Processor
except ImportError:
    try:
        from transformers import Florence2Processor
    except ImportError:
        Florence2Processor = None

SCRIPT_DIR = Path(__file__).parent
MODEL_DIR = SCRIPT_DIR / "weights" / "icon_caption"

app = Flask(__name__)


@app.route("/")
def index():
    html = (SCRIPT_DIR / "index.html").read_text(encoding="utf-8")
    return html

# Load model and processor once at startup
model = None
processor = None


def load_model():
    global model, processor
    if model is not None:
        return
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if MODEL_DIR.exists():
        model_path = str(MODEL_DIR)
        print(f"[icon-caption] Loading model from {model_path} on {device}...")
    else:
        model_path = "microsoft/OmniParser-v2.0"
        print(f"[icon-caption] Loading from HuggingFace {model_path} (run ./download_model.sh to cache locally)")
    if Florence2Processor is not None:
        processor = Florence2Processor.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)
    else:
        from transformers import AutoProcessor
        processor = AutoProcessor.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)
    load_kwargs = {
        "torch_dtype": torch.float16 if device == "cuda" else torch.float32,
        "trust_remote_code": True,
    }
    if not MODEL_DIR.exists():
        load_kwargs["subfolder"] = "icon_caption"
    model = AutoModelForCausalLM.from_pretrained(model_path, **load_kwargs).to(device)
    model.eval()
    print("[icon-caption] Model loaded")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/captions", methods=["POST"])
def captions():
    """POST /captions with JSON body: {"images": ["base64...", "base64..."]}
    Returns: {"captions": ["caption1", "caption2"]}
    """
    load_model()
    data = request.get_json()
    if not data or "images" not in data:
        return jsonify({"error": "Missing images array"}), 400
    images_b64 = data["images"]
    if not isinstance(images_b64, list):
        return jsonify({"error": "images must be an array"}), 400

    captions_out = []
    device = next(model.parameters()).device
    prompt = " "
    batch_size = 32

    for i in range(0, len(images_b64), batch_size):
        batch = images_b64[i : i + batch_size]
        pil_images = []
        for b64 in batch:
            try:
                img_bytes = base64.b64decode(b64)
                img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                img = img.resize((64, 64), Image.Resampling.LANCZOS)
                pil_images.append(img)
            except Exception:
                pil_images.append(Image.new("RGB", (64, 64), (128, 128, 128)))

        if not pil_images:
            continue

        try:
            inputs = processor(
                images=pil_images,
                text=[prompt] * len(pil_images),
                return_tensors="pt",
                do_resize=False,
            ).to(device=device, dtype=torch.float16 if device.type == "cuda" else torch.float32)
            with torch.no_grad():
                generated_ids = model.generate(
                    input_ids=inputs["input_ids"],
                    pixel_values=inputs["pixel_values"],
                    max_new_tokens=20,
                    num_beams=1,
                    do_sample=False,
                )
            generated = processor.batch_decode(generated_ids, skip_special_tokens=True)
            captions_out.extend([g.strip() for g in generated])
        except Exception as e:
            captions_out.extend([f"(error: {e})"] * len(pil_images))

    return jsonify({"captions": captions_out})


def main():
    load_model()
    port = int(os.environ.get("PORT", 5900))
    print(f"[icon-caption] Listening on {port}")
    app.run(host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
