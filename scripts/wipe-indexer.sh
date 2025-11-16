#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHOTON_STATE_DIR="${PHOTON_STATE_DIR:-$PROJECT_ROOT/indexer/photon/data}"
PHOTON_STATE_FILE="${PHOTON_STATE_DIR}/state.json"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_success() {
  printf '[%s] \033[0;32m✓ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log "Wiping indexer state at ${PHOTON_STATE_DIR}..."
rm -rf "${PHOTON_STATE_DIR}"
mkdir -p "${PHOTON_STATE_DIR}"
printf '{}\n' >"${PHOTON_STATE_FILE}"
log_success "Indexer state wiped"

