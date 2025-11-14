#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_DIR="${LEDGER_DIR:-$HOME/.local/share/zpump-devnet-ledger}"
PHOTON_STATE_DIR="$PROJECT_ROOT/indexer/photon/data"
PHOTON_STATE_FILE="$PHOTON_STATE_DIR/state.json"
PM2_BIN="${PM2_BIN:-pm2}"
RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
VALIDATOR_APP="ptf-validator"
INDEXER_APP="ptf-indexer"
PROOF_APP="ptf-proof"
WEB_APP="ptf-web"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "fatal: required command '$1' not found in PATH"
    exit 1
  fi
}

wait_for_rpc() {
  local retries=60
  log "Waiting for validator RPC at ${RPC_URL}..."
  for ((i = 0; i < retries; i++)); do
    if solana -u "${RPC_URL}" slot >/dev/null 2>&1; then
      log "Validator RPC is ready."
      return 0
    fi
    sleep 1
  done
  log "fatal: validator RPC did not become ready within ${retries}s"
  exit 1
}

start_pm2_app() {
  local name="$1"
  local cmd="$2"
  log "Starting ${name} via PM2 (${cmd})"
  "${PM2_BIN}" start /usr/bin/bash --name "${name}" --log "${PROJECT_ROOT}/.pm2-${name}.log" -- -c "cd '${PROJECT_ROOT}' && ${cmd}"
}

require_cmd "${PM2_BIN}"
require_cmd solana
require_cmd npx
require_cmd npm

log "Stopping existing PM2 processes..."
"${PM2_BIN}" delete all >/dev/null 2>&1 || true

log "Stopping any running solana-test-validator..."
pkill -f solana-test-validator >/dev/null 2>&1 || true

log "Resetting validator ledger at ${LEDGER_DIR}"
rm -rf "${LEDGER_DIR}"
mkdir -p "${LEDGER_DIR}"

log "Resetting Photon snapshot at ${PHOTON_STATE_FILE}"
rm -rf "${PHOTON_STATE_DIR}"
mkdir -p "${PHOTON_STATE_DIR}"
printf '{}\n' >"${PHOTON_STATE_FILE}"

log "Ensuring Proof RPC circuits symlink exists"
ln -snf ../circuits "${PROJECT_ROOT}/services/circuits"

log "Starting validator under PM2 (${VALIDATOR_APP})"
start_pm2_app "${VALIDATOR_APP}" "./scripts/start-private-devnet.sh"

wait_for_rpc

log "Installing Photon dependencies (npm install --prefix indexer/photon)"
(cd "${PROJECT_ROOT}/indexer/photon" && npm install >/dev/null)

log "Installing Proof RPC dependencies (npm install --prefix services/proof-rpc)"
(cd "${PROJECT_ROOT}/services/proof-rpc" && npm install >/dev/null)

log "Bootstrapping devnet state via bootstrap-private-devnet.ts"
(cd "${PROJECT_ROOT}" && npx tsx web/app/scripts/bootstrap-private-devnet.ts)

log "Starting Photon indexer (${INDEXER_APP})"
start_pm2_app "${INDEXER_APP}" "npm run start --prefix indexer/photon"

log "Starting Proof RPC (${PROOF_APP})"
start_pm2_app "${PROOF_APP}" "npm run start --prefix services/proof-rpc"

log "Starting Next.js dev server (${WEB_APP})"
start_pm2_app "${WEB_APP}" "npm run dev --prefix web/app"

log "All services launched. Current PM2 status:"
"${PM2_BIN}" list

log "Reset complete."

