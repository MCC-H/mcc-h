#!/bin/bash
# Build and package Houston for Apple ARM64 with code signing.
# Certificate: F44ZS9HT2P
# See launch.sh for dev build/run flow.
set -e
cd "$(dirname "$0")"

ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  echo "[build] ERROR: This script builds for Apple ARM64 only. Current arch: $ARCH"
  exit 1
fi

echo "[build] Building Houston for macOS arm64..."
cd houston

echo "[build] Installing dependencies..."
npm install

echo "[build] Building Electron app..."
npm run electron:build

echo "[build] Building HoustonVM (release)..."
./scripts/build-houston-vm.sh

echo "[build] Building HoustonAI (release)..."
(cd houston-ai && swift build -c release)

echo "[build] Copying binaries and resources..."
./scripts/copy-houston-vm.sh

echo "[build] Downloading llama-cpp..."
./scripts/download-llama-cpp.sh

echo "[build] Packaging with electron-builder (arm64, code signing)..."
CSC_NAME="F44ZS9HT2P" \
  npx electron-builder --mac --arm64

echo "[build] Done. Output in houston/release/"
