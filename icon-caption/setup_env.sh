#!/bin/bash
# Create fresh conda env for icon-caption.
# Run: ./setup_env.sh
set -e

cd "$(dirname "$0")"

if conda env list | grep -q "^icon-caption "; then
  echo "[icon-caption] Environment 'icon-caption' exists. Updating..."
  conda env update -f environment.yml --prune
else
  echo "[icon-caption] Creating environment 'icon-caption'..."
  conda env create -f environment.yml
fi

echo "[icon-caption] Done. Run ./run.sh to start the server."
