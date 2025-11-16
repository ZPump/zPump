#!/usr/bin/env bash

set -euo pipefail

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

# Check current version
CURRENT_VERSION=$(solana --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "unknown")
log_info "Current Solana version: ${CURRENT_VERSION}"

# Check mainnet version
log_info "Checking mainnet version..."
MAINNET_VERSION=$(solana cluster-version -um 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "unknown")
log_info "Mainnet version: ${MAINNET_VERSION}"

if [[ "${CURRENT_VERSION}" == "${MAINNET_VERSION}" ]]; then
  log_success "Already on mainnet version ${MAINNET_VERSION}"
  exit 0
fi

log_info "Upgrading Solana to match mainnet version ${MAINNET_VERSION}..."

# Stop validator if running
if systemctl --user is-active --quiet zpump-devnet 2>/dev/null; then
  log_info "Stopping validator..."
  systemctl --user stop zpump-devnet
fi

if pgrep -f solana-test-validator >/dev/null; then
  log_info "Stopping running validator processes..."
  pkill -f solana-test-validator || true
  sleep 2
fi

# Install/upgrade Solana
log_info "Installing Solana ${MAINNET_VERSION}..."
if sh -c "$(curl -sSfL https://release.solana.com/v${MAINNET_VERSION}/install)"; then
  log_success "Solana ${MAINNET_VERSION} installed"
else
  log_error "Failed to install Solana ${MAINNET_VERSION}"
  log_info "Trying stable release instead..."
  if sh -c "$(curl -sSfL https://release.solana.com/stable/install)"; then
    log_success "Solana stable release installed"
  else
    log_error "Failed to install Solana"
    exit 1
  fi
fi

# Update PATH for current session
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Verify new version
NEW_VERSION=$(solana --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "unknown")
log_success "Solana upgraded to version ${NEW_VERSION}"

# Verify test validator version
TEST_VALIDATOR_VERSION=$(solana-test-validator --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "unknown")
log_success "Test validator version: ${TEST_VALIDATOR_VERSION}"

log_info "Next steps:"
log_info "1. Rebuild programs: anchor build"
log_info "2. Reset devnet: ./scripts/reset-dev-env.sh"
log_info "3. Test syscall: anchor build --features groth16-syscall"

