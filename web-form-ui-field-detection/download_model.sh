#!/bin/bash
# Download foduucom/web-form-ui-field-detection model.
# Run: ./download_model.sh (or python download_model.py)
set -e

cd "$(dirname "$0")"
conda run -n web-form-ui-field-detection python download_model.py
