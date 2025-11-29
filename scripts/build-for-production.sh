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

# Note: build-all-programs.sh builds all programs individually
# For production builds with features, we need to build each program with the feature
ALL_PROGRAMS=(
  "ptf_factory"
  "ptf_vault"
  "ptf_verifier_groth16"
  "ptf_pool"
  "ptf_dex"
)

BUILD_FAILED=0
for program in "${ALL_PROGRAMS[@]}"; do
  log "Building ${program} with groth16-syscall feature..."
  if anchor build --features groth16-syscall --program-name "${program}" 2>&1 | tee -a "${PROJECT_ROOT}/.anchor-build-production.log"; then
    log_success "${program} built successfully"
  else
    log_error "${program} build failed"
    BUILD_FAILED=1
  fi
done

if [[ ${BUILD_FAILED} -eq 1 ]]; then
  log_error "Production build failed. Check .anchor-build-production.log for details"
  exit 1
fi

log_success "Production build completed successfully"
log "Programs built with groth16-syscall feature - ready for mainnet deployment"
log "Binary location: ${PROJECT_ROOT}/target/deploy/"
exit 0

