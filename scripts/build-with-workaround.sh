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

log "Building all programs with workaround for anchor-syn bug..."

# Programs that build fine normally
STANDARD_PROGRAMS=("ptf_factory" "ptf_vault" "ptf_verifier_groth16")

# Programs with idl-build (anchor-syn bug)
IDL_BUILD_PROGRAMS=("ptf_pool" "ptf_dex")

BUILD_FAILED=0

# Build standard programs
for program in "${STANDARD_PROGRAMS[@]}"; do
  log_info "Building ${program}..."
  if anchor build --no-idl --program-name "${program}" 2>&1 | tee -a "${PROJECT_ROOT}/.build-${program}.log"; then
    log_success "${program} built"
  else
    log_error "${program} failed"
    BUILD_FAILED=1
  fi
done

# For pool and dex, we need to work around anchor-syn bug
# Strategy: Use cargo build-sbf directly if available, or skip if .so already exists
for program in "${IDL_BUILD_PROGRAMS[@]}"; do
  if [[ -f "${PROJECT_ROOT}/target/deploy/${program}.so" ]]; then
    log_info "${program}.so already exists, skipping build"
    continue
  fi
  
  log_error "${program} cannot be built due to anchor-syn bug when idl-build is enabled"
  log_info "You may need to:"
  log_info "  1. Build ${program} separately with idl-build feature disabled temporarily"
  log_info "  2. Or use a pre-built .so file"
  log_info "  3. Or upgrade/downgrade Anchor to a version without this bug"
  BUILD_FAILED=1
done

# Generate IDLs
log_info "Generating IDLs..."
ALL_PROGRAMS=("${STANDARD_PROGRAMS[@]}" "${IDL_BUILD_PROGRAMS[@]}")
for program in "${ALL_PROGRAMS[@]}"; do
  log_info "Generating IDL for ${program}..."
  if anchor idl build --program-name "${program}" 2>&1 | tee -a "${PROJECT_ROOT}/.idl-${program}.log"; then
    log_success "${program} IDL generated"
  else
    log_error "${program} IDL failed"
    BUILD_FAILED=1
  fi
done

if [[ ${BUILD_FAILED} -eq 1 ]]; then
  log_error "Some builds failed. Pool and dex may need manual build."
  exit 1
fi

log_success "Build complete!"

