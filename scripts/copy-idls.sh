#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_info() {
  printf '[%s] \033[0;34mℹ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_success() {
  printf '[%s] \033[0;32m✓ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

cd "${PROJECT_ROOT}"

mkdir -p target/idl

# Copy IDLs from web/app/idl if they exist (source of truth)
log_info "Copying IDLs from web/app/idl to target/idl..."

for idl in ptf_factory ptf_vault ptf_verifier_groth16 ptf_pool ptf_dex; do
  if [[ -f "web/app/idl/${idl}.json" ]]; then
    cp "web/app/idl/${idl}.json" "target/idl/${idl}.json"
    log_success "${idl} IDL copied"
  else
    log_info "${idl} IDL not found in web/app/idl, skipping"
  fi
done

log_success "IDL copy complete!"

