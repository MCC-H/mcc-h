#!/bin/bash
# Run icon caption server. Uses conda env 'icon-caption'.
# Run ./setup_env.sh first to create the env.
# Run: ./run.sh
set -e

cd "$(dirname "$0")"

if ! conda env list | grep -q "^icon-caption "; then
  echo "[icon-caption] Environment not found. Run ./setup_env.sh first."
  exit 1
fi

export PORT="${PORT:-5900}"
echo "[icon-caption] Starting on port $PORT (conda env: icon-caption)"
conda run -n icon-caption python server.py
