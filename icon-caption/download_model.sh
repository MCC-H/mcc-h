#!/bin/bash
# Download OmniParser icon_caption model from HuggingFace.
# Run ./setup_env.sh first. Run: ./download_model.sh
set -e

cd "$(dirname "$0")"
conda run -n icon-caption python download_model.py
