#!/bin/bash
set -e
cd "$(dirname "$0")/.."

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  BIN="houston-vm/.build/arm64-apple-macosx/debug/HoustonVM"
  [ -f "$BIN" ] || BIN="houston-vm/.build/arm64-apple-macosx/release/HoustonVM"
else
  BIN="houston-vm/.build/x86_64-apple-macosx/debug/HoustonVM"
  [ -f "$BIN" ] || BIN="houston-vm/.build/x86_64-apple-macosx/release/HoustonVM"
fi

if [ ! -f "$BIN" ]; then
  echo "[Houston] HoustonVM binary not found at $BIN, skipping copy"
  exit 0
fi

mkdir -p dist-electron/resources
cp "$BIN" dist-electron/resources/HoustonVM

# Copy Core ML models and assets next to the binary
RESOURCES="houston-vm/Sources/HoustonVM/Resources"
for pkg in CheckboxDetector OmniParserDetector IconCaptionDetector UIElementsDetector; do
  src="$RESOURCES/${pkg}.mlpackage"
  if [ -d "$src" ]; then
    cp -R "$src" dist-electron/resources/
  fi
done
for f in spectrum_features.bin spectrum_short_names.json spectrum_descriptions.json; do
  src="$RESOURCES/$f"
  if [ -f "$src" ]; then
    cp "$src" dist-electron/resources/
  fi
done

ENTITLEMENTS="houston-vm/HoustonVM.entitlements"
if [ -f "$ENTITLEMENTS" ]; then
  echo "[Houston] Signing HoustonVM with virtualization entitlement (ad-hoc)..."
  codesign --force --sign - --entitlements "$ENTITLEMENTS" dist-electron/resources/HoustonVM
fi

# HoustonAI (OCR, captions, models)
if [ "$ARCH" = "arm64" ]; then
  AI_BIN="houston-ai/.build/arm64-apple-macosx/debug/HoustonAI"
  [ -f "$AI_BIN" ] || AI_BIN="houston-ai/.build/arm64-apple-macosx/release/HoustonAI"
else
  AI_BIN="houston-ai/.build/x86_64-apple-macosx/debug/HoustonAI"
  [ -f "$AI_BIN" ] || AI_BIN="houston-ai/.build/x86_64-apple-macosx/release/HoustonAI"
fi
if [ -f "$AI_BIN" ]; then
  cp "$AI_BIN" dist-electron/resources/HoustonAI
  echo "[Houston] Copied HoustonAI to dist-electron/resources/"
else
  echo "[Houston] HoustonAI binary not found at $AI_BIN, skipping (build with: cd houston-ai && swift build)"
fi

./scripts/download-llama-cpp.sh

echo "[Houston] Copied HoustonVM to dist-electron/resources/"
