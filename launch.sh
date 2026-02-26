#!/bin/bash
set -e
cd "$(dirname "$0")"

# Build and run Houston
echo "Building Houston..."
cd houston
npm install
# Build HoustonVM (copy-houston-vm.sh copies it to dist-electron/resources)
echo "Building HoustonVM..."
(cd houston-vm && swift build)

# Build HoustonAI (OCR, captions, models - copy-houston-vm.sh copies it too)
echo "Building HoustonAI..."
(cd houston-ai && swift build)

npm run electron:build

echo "Launching Houston..."
exec npx electron .
