#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_success() {
  printf '[%s] \033[0;32m✓ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_error() {
  printf '[%s] \033[0;31mERROR: %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

cd "${PROJECT_ROOT}"

log "Building Anchor programs with groth16-syscall feature for production..."

if anchor build --features groth16-syscall 2>&1 | tee "${PROJECT_ROOT}/.anchor-build-production.log; then
  log_success "Production build completed successfully"
  log "Programs built with groth16-syscall feature - ready for mainnet deployment"
  log "Binary location: ${PROJECT_ROOT}/target/deploy/"
  exit 0
else
  log_error "Production build failed. Check .anchor-build-production.log for details"
  exit 1
fi

