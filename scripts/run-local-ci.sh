#!/usr/bin/env bash
set -euo pipefail

# Ensures the deployable artifacts exist before running the harness suite.
ANCHOR_BIN=${ANCHOR_BIN:-anchor}
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/tmp/zpump-target}

export CARGO_TARGET_DIR
export OPENSSL_NO_VENDOR=1
export PKG_CONFIG_PATH=${PKG_CONFIG_PATH:-/usr/lib/x86_64-linux-gnu/pkgconfig}

if ! command -v "$ANCHOR_BIN" >/dev/null 2>&1; then
  echo "error: anchor CLI not found (expected '$ANCHOR_BIN'). Install Anchor 0.32.1 before running this script." >&2
  exit 1
fi

echo "==> Building BPF artifacts via Anchor"
"$ANCHOR_BIN" build --no-idl

echo "==> Running program-test harness (ignored tests)"
cargo test -p program-test-harness -- --ignored
