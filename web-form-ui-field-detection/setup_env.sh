#!/bin/bash
# Create fresh conda env for web-form-ui-field-detection.
# Run: ./setup_env.sh
set -e

cd "$(dirname "$0")"

if conda env list | grep -q "^web-form-ui-field-detection "; then
  echo "[web-form-ui] Environment exists. Updating..."
  conda env update -f environment.yml --prune
else
  echo "[web-form-ui] Creating environment..."
  conda env create -f environment.yml
fi

echo "[web-form-ui] Done. Run ./run.sh to start the server."
