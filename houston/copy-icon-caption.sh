#!/bin/bash
# Copy IconCaptionDetector model and assets from test-clip to Houston Resources.
# Run: ./copy-icon-caption.sh
# Prerequisites:
#   1. test-clip/convert.sh (CoreML model)
#   2. test-clip server run once (generates cache)
#   3. conda run -n test-clip python test-clip/export_assets.py
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_CLIP="$SCRIPT_DIR/../test-clip"
CACHE="$TEST_CLIP/cache"
MODEL_SRC="$TEST_CLIP/CLIPImageEncoder.mlpackage"
DEST_DIR="$SCRIPT_DIR/houston-vm/Sources/HoustonVM/Resources"
DEST_ELECTRON="$SCRIPT_DIR/dist-electron/resources"

if [[ ! -d "$MODEL_SRC" ]]; then
  echo "[copy-icon-caption] Model not found: $MODEL_SRC"
  echo "Run: cd test-clip && ./convert.sh"
  exit 1
fi

if [[ ! -f "$CACHE/spectrum_features.bin" ]]; then
  echo "[copy-icon-caption] Assets not found. Run:"
  echo "  1. cd test-clip && ./run.sh  (once, to generate cache)"
  echo "  2. conda run -n test-clip python test-clip/export_assets.py"
  exit 1
fi

mkdir -p "$DEST_DIR"
rm -rf "$DEST_DIR/IconCaptionDetector.mlpackage"
cp -R "$MODEL_SRC" "$DEST_DIR/IconCaptionDetector.mlpackage"
cp "$CACHE/spectrum_features.bin" "$DEST_DIR/"
cp "$CACHE/spectrum_short_names.json" "$DEST_DIR/"
cp "$CACHE/spectrum_descriptions.json" "$DEST_DIR/"
echo "[copy-icon-caption] Copied to $DEST_DIR"

if [[ -d "$(dirname "$DEST_ELECTRON")" ]]; then
  mkdir -p "$DEST_ELECTRON"
  rm -rf "$DEST_ELECTRON/IconCaptionDetector.mlpackage"
  cp -R "$MODEL_SRC" "$DEST_ELECTRON/IconCaptionDetector.mlpackage"
  cp "$CACHE/spectrum_features.bin" "$DEST_ELECTRON/"
  cp "$CACHE/spectrum_short_names.json" "$DEST_ELECTRON/"
  cp "$CACHE/spectrum_descriptions.json" "$DEST_ELECTRON/"
  echo "[copy-icon-caption] Copied to $DEST_ELECTRON"
fi
