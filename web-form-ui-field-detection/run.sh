#!/bin/bash
# Run form UI field detection server. Uses conda env 'web-form-ui-field-detection'.
# Run ./setup_env.sh first to create the env.
set -e

cd "$(dirname "$0")"

if ! conda env list | grep -q "^web-form-ui-field-detection "; then
  echo "[web-form-ui] Environment not found. Run ./setup_env.sh first."
  exit 1
fi

export PORT="${PORT:-5901}"
echo "[web-form-ui] Starting on port $PORT (conda env: web-form-ui-field-detection)"
conda run -n web-form-ui-field-detection python server.py
