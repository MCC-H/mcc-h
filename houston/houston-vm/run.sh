#!/bin/bash
set -e
cd "$(dirname "$0")"
swift build -c debug
BIN=".build/debug/HoustonVM"
codesign -s - --entitlements HoustonVM.entitlements --force "$BIN"
exec "$BIN"
