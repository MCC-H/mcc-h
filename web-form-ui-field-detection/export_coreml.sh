#!/bin/bash
# Export web-form-ui-field-detection to CoreML. Run on macOS only.
set -e

cd "$(dirname "$0")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[export_coreml] CoreML export requires macOS. Skipping."
  exit 0
fi

conda run -n web-form-ui-field-detection python export_coreml.py
