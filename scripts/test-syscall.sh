#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_success() {
  printf '[%s] \033[0;32m✓ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log_error() {
  printf '[%s] \033[0;31mERROR: %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

log_info() {
  printf '[%s] \033[0;34mℹ %s\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

cd "${PROJECT_ROOT}"

log_info "Testing groth16 syscall support in local validator..."

# Check validator is running
if ! solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; then
  log_error "Validator is not running. Start it first:"
  log_info "  systemctl --user start zpump-devnet"
  log_info "  OR"
  log_info "  ./scripts/start-private-devnet.sh"
  exit 1
fi

log_info "Building verifier program with groth16-syscall feature..."
cd programs/verifier-groth16
if cargo build-sbf --no-default-features --features groth16-syscall 2>&1 | tee /tmp/groth16-build.log | tail -20; then
  log_success "Build completed"
else
  log_error "Build failed. Check /tmp/groth16-build.log"
  exit 1
fi

cd "${PROJECT_ROOT}"

log_info "Deploying verifier program to test syscall..."
if solana program deploy target/deploy/ptf_verifier_groth16.so \
  --program-id target/deploy/ptf_verifier_groth16-keypair.json \
  --url http://127.0.0.1:8899 2>&1 | tee /tmp/groth16-deploy.log; then
  log_success "Deployment successful - syscall appears to be supported!"
  log_info "The groth16 syscall is available in your local validator"
  exit 0
else
  DEPLOY_ERROR=$(cat /tmp/groth16-deploy.log | grep -i "unresolved\|error" | head -5)
  if echo "$DEPLOY_ERROR" | grep -qi "unresolved.*sol_groth16_verify"; then
    log_error "Syscall NOT available - deployment failed with unresolved symbol"
    log_info "The test validator does not support sol_groth16_verify syscall"
    log_info "Use testnet for final testing before mainnet"
    exit 1
  else
    log_error "Deployment failed for other reasons. Check /tmp/groth16-deploy.log"
    exit 1
  fi
fi

