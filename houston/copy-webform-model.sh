#!/bin/bash
# Copy WebFormDetector.mlpackage from web-form-ui-field-detection export to Houston Resources.
# Run: ./copy-webform-model.sh
# Prerequisite: Run web-form-ui-field-detection/export_coreml.sh first.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../web-form-ui-field-detection/weights/web-form-ui-field-detection.mlpackage"
DEST="$SCRIPT_DIR/houston-vm/Sources/HoustonVM/Resources/WebFormDetector.mlpackage"
DEST_ELECTRON="$SCRIPT_DIR/dist-electron/resources/WebFormDetector.mlpackage"

if [[ ! -d "$SRC" ]]; then
  echo "[copy-webform-model] Source not found: $SRC"
  echo "Run: cd web-form-ui-field-detection && ./export_coreml.sh"
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "[copy-webform-model] Copied to $DEST"

if [[ -d "$(dirname "$DEST_ELECTRON")" ]]; then
  rm -rf "$DEST_ELECTRON"
  cp -R "$SRC" "$DEST_ELECTRON"
  echo "[copy-webform-model] Copied to $DEST_ELECTRON"
fi
