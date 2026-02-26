#!/bin/bash
set -e
cd "$(dirname "$0")/.."

ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  echo "[Houston] llama-cpp download: arm64 only, skipping (arch=$ARCH)"
  exit 0
fi

LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/b8149/llama-b8149-bin-macos-arm64.tar.gz"
RESOURCES="dist-electron/resources"
LLAMA_DIR="$RESOURCES/llama-b8149"

if [ -f "$LLAMA_DIR/llama-server" ]; then
  echo "[Houston] llama-server already at $LLAMA_DIR"
  exit 0
fi

echo "[Houston] Downloading llama-cpp..."
mkdir -p "$RESOURCES"
TAR="$RESOURCES/llama.tar.gz"
curl -sL "$LLAMA_URL" -o "$TAR"

echo "[Houston] Extracting llama-server..."
tar -xzf "$TAR" -C "$RESOURCES"
rm -f "$TAR"

if [ ! -f "$LLAMA_DIR/llama-server" ]; then
  echo "[Houston] ERROR: llama-server not found after extraction"
  exit 1
fi

echo "[Houston] Copied llama-cpp to $RESOURCES/"
