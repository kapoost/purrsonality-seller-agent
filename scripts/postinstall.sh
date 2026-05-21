#!/usr/bin/env bash
# Workaround for adcontextprotocol/adcp-client#1917 — @adcp/sdk@7.10.x
# packaging bug: v2/projection registry loader looks for schemas at
# `schemas/cache/` but the SDK ships them at `dist/lib/schemas-data/`.
# Symlink one to the other after install so storyboard runner finds them.
# Remove this script once SDK 7.10.2+ ships the proper path.

set -eu

SDK_DIR="${SDK_DIR:-node_modules/@adcp/sdk}"
if [ ! -d "$SDK_DIR/dist/lib/schemas-data" ]; then
  exit 0
fi
if [ -e "$SDK_DIR/schemas/cache" ]; then
  exit 0
fi

mkdir -p "$SDK_DIR/schemas"
ln -s "../dist/lib/schemas-data" "$SDK_DIR/schemas/cache"
echo "[postinstall] linked $SDK_DIR/schemas/cache -> dist/lib/schemas-data (workaround for adcp-client#1917)"
