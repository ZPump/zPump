#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_error() {
  printf '[%s] \033[0;31mERROR: %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

log_success() {
  printf '[%s] \033[0;32m✓ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_info() {
  printf '[%s] \033[0;34mℹ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

cd "${PROJECT_ROOT}"

log "Building all programs..."

ALL_PROGRAMS=(
  "ptf_factory"
  "ptf_vault"
  "ptf_verifier_groth16"
  "ptf_pool"
  "ptf_dex"
)

BUILD_FAILED=0

# Build all programs with --no-idl to skip IDL generation during build
for program in "${ALL_PROGRAMS[@]}"; do
  log_info "Building ${program}..."
  if anchor build --no-idl --program-name "${program}" 2>&1 | tee -a "${PROJECT_ROOT}/.build-${program}.log"; then
    log_success "${program} built"
  else
    log_error "${program} failed"
    BUILD_FAILED=1
  fi
done

# Copy IDLs from web/app/idl (they're manually maintained there)
log_info "Copying IDLs from web/app/idl..."
if [[ -f "${PROJECT_ROOT}/scripts/copy-idls.sh" ]]; then
  "${PROJECT_ROOT}/scripts/copy-idls.sh"
else
  log_info "copy-idls.sh not found, skipping IDL copy"
fi

if [[ ${BUILD_FAILED} -eq 1 ]]; then
  log_error "Some builds failed"
  exit 1
fi

log_success "All programs built!"

# Verify artifacts
log_info "Verifying artifacts..."
MISSING=0
for program in "${ALL_PROGRAMS[@]}"; do
  if [[ -f "${PROJECT_ROOT}/target/deploy/${program}.so" ]]; then
    SIZE=$(stat -c%s "${PROJECT_ROOT}/target/deploy/${program}.so" 2>/dev/null || stat -f%z "${PROJECT_ROOT}/target/deploy/${program}.so" 2>/dev/null || echo "0")
    log_success "${program}.so ($((SIZE/1024))KB)"
  else
    log_error "${program}.so missing"
    MISSING=1
  fi
done

[[ ${MISSING} -eq 0 ]] && log_success "All artifacts verified!" || exit 1
