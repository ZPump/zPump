#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
DEPLOYER_KEYPAIR="${DEPLOYER_KEYPAIR:-$HOME/.config/solana/id.json}"

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

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_error "Required command '$1' not found in PATH"
    exit 1
  fi
}

wait_for_rpc() {
  local retries=30
  log_info "Waiting for validator RPC at ${RPC_URL}..."
  for ((i = 0; i < retries; i++)); do
    if solana -u "${RPC_URL}" slot >/dev/null 2>&1; then
      log_success "Validator RPC is ready"
      return 0
    fi
    sleep 1
  done
  log_error "Validator RPC did not become ready within ${retries}s"
  exit 1
}

require_cmd anchor
require_cmd solana
require_cmd cargo

cd "${PROJECT_ROOT}"

log "Building Anchor programs..."
if ! anchor build -- 2>&1 | tee "${PROJECT_ROOT}/.anchor-build.log"; then
  log_error "Anchor build failed. Check .anchor-build.log for details"
  exit 1
fi
log_success "Anchor programs built successfully"

wait_for_rpc

log "Deploying programs to ${RPC_URL}..."

# Deploy using solana program deploy for each program
log "Deploying all programs..."
PROGRAMS=(
  "ptf_factory:4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy"
  "ptf_vault:9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh"
  "ptf_pool:7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh"
  "ptf_verifier_groth16:3aCv39mCRFH9BGJskfXqwQoWzW1ULq2yXEbEwGgKtLgg"
)

for program_info in "${PROGRAMS[@]}"; do
  IFS=':' read -r program_name program_id <<< "${program_info}"
  program_so="${PROJECT_ROOT}/target/deploy/${program_name}.so"
  program_keypair="${PROJECT_ROOT}/target/deploy/${program_name}-keypair.json"
  
  if [[ ! -f "${program_so}" ]]; then
    log_error "Program binary not found: ${program_so}"
    exit 1
  fi
  
  log "Deploying ${program_name} (${program_id})..."
  if solana program deploy \
    --url "${RPC_URL}" \
    --program-id "${program_keypair}" \
    "${program_so}" 2>&1 | tee -a "${PROJECT_ROOT}/.deploy.log"; then
    log_success "${program_name} deployed successfully"
  else
    log_error "Failed to deploy ${program_name}"
    exit 1
  fi
done

log_success "All programs deployed successfully"

