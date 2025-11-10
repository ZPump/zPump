#!/usr/bin/env bash
set -euo pipefail

# Ensures the deployable artifacts exist before running the harness suite.
ANCHOR_BIN=${ANCHOR_BIN:-anchor}

if ! command -v "$ANCHOR_BIN" >/dev/null 2>&1; then
  echo "error: anchor CLI not found (expected '$ANCHOR_BIN'). Install Anchor 0.32.1 before running this script." >&2
  exit 1
fi

echo "==> Building BPF artifacts via Anchor"
"$ANCHOR_BIN" build

echo "==> Running program-test harness (ignored tests)"
cargo test -p program-test-harness -- --ignored
