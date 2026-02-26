#!/bin/bash
set -e
cd "$(dirname "$0")/.."
VM_DIR="houston-vm"
IDENTITY="F44ZS9HT2P"

echo "[Houston] Building HoustonVM (release)..."
cd "$VM_DIR"
swift build -c release

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  BIN=".build/arm64-apple-macosx/release/HoustonVM"
else
  BIN=".build/x86_64-apple-macosx/release/HoustonVM"
fi

if [ ! -f "$BIN" ]; then
  echo "[Houston] HoustonVM binary not found at $BIN"
  exit 1
fi

echo "[Houston] Signing HoustonVM with Developer ID and virtualization entitlement..."
codesign --force --sign "$IDENTITY" --entitlements HoustonVM.entitlements "$BIN"

echo "[Houston] HoustonVM built and signed at $VM_DIR/$BIN"
