#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_DIR="${LEDGER_DIR:-$HOME/.local/share/zpump-devnet-ledger}"
PHOTON_STATE_DIR="$PROJECT_ROOT/indexer/photon/data"
PHOTON_STATE_FILE="$PHOTON_STATE_DIR/state.json"
MINT_CATALOG_PATH="${MINT_CATALOG_PATH:-$PROJECT_ROOT/web/app/config/mints.generated.json}"
FAUCET_LOG_DEFAULT="$PROJECT_ROOT/web/app/faucet-events.json"
FAUCET_LOG_LEGACY="$PROJECT_ROOT/faucet-events.json"
PM2_BIN="${PM2_BIN:-pm2}"
RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
VALIDATOR_APP="ptf-validator"
INDEXER_APP="ptf-indexer"
PROOF_APP="ptf-proof"
WEB_APP="ptf-web"
VALIDATOR_SYSTEMD_SERVICE="${VALIDATOR_SYSTEMD_SERVICE:-zpump-devnet}"
TEST_WALLET_PATH="${TEST_WALLET_PATH:-$HOME/.config/solana/id.json}"
RUN_SMOKE_TESTS="${RUN_SMOKE_TESTS:-true}"
SMOKE_TEST_SCRIPT="${SMOKE_TEST_SCRIPT:-scripts/wrap-unwrap-local.ts}"
WEB_HEALTH_URL="${WEB_HEALTH_URL:-http://127.0.0.1:3000/api/mints}"

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

wait_for_web() {
  local retries=60
  log "Waiting for Next.js API at ${WEB_HEALTH_URL}..."
  for ((i = 0; i < retries; i++)); do
    if curl -s "${WEB_HEALTH_URL}" >/dev/null 2>&1; then
      log "Next.js API is ready."
      return 0
    fi
    sleep 2
  done
  log "fatal: Next.js API did not become ready within $((retries * 2))s"
  exit 1
}

using_systemd_validator=false
if [[ -n "${VALIDATOR_SYSTEMD_SERVICE}" ]] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user --quiet is-active "${VALIDATOR_SYSTEMD_SERVICE}" >/dev/null 2>&1 || \
     systemctl --user --quiet is-enabled "${VALIDATOR_SYSTEMD_SERVICE}" >/dev/null 2>&1; then
    using_systemd_validator=true
  fi
fi

if [[ "${using_systemd_validator}" == true ]]; then
  log "Detected systemd-managed validator service (${VALIDATOR_SYSTEMD_SERVICE}); PM2 validator will be skipped."
fi

require_cmd "${PM2_BIN}"
require_cmd solana
require_cmd npx
require_cmd npm
require_cmd curl

if [[ ! -f "${TEST_WALLET_PATH}" ]]; then
  log "Generating test wallet at ${TEST_WALLET_PATH}"
  mkdir -p "$(dirname "${TEST_WALLET_PATH}")"
  solana-keygen new -o "${TEST_WALLET_PATH}" -f >/dev/null
fi

log "Stopping existing PM2 processes..."
"${PM2_BIN}" delete all >/dev/null 2>&1 || true

if [[ "${using_systemd_validator}" == true ]]; then
  log "Stopping systemd validator service (${VALIDATOR_SYSTEMD_SERVICE})"
  systemctl --user stop "${VALIDATOR_SYSTEMD_SERVICE}" >/dev/null 2>&1 || true
fi

log "Stopping any running solana-test-validator..."
pkill -f solana-test-validator >/dev/null 2>&1 || true

log "Resetting validator ledger at ${LEDGER_DIR}"
rm -rf "${LEDGER_DIR}"
mkdir -p "${LEDGER_DIR}"

log "Resetting Photon snapshot at ${PHOTON_STATE_FILE}"
rm -rf "${PHOTON_STATE_DIR}"
mkdir -p "${PHOTON_STATE_DIR}"
printf '{}\n' >"${PHOTON_STATE_FILE}"

reset_mint_catalog() {
  log "Resetting mint catalog at ${MINT_CATALOG_PATH}"
  mkdir -p "$(dirname "${MINT_CATALOG_PATH}")"
  printf '[]\n' >"${MINT_CATALOG_PATH}"
}

reset_faucet_logs() {
  log "Resetting faucet event logs"
  mkdir -p "$(dirname "${FAUCET_LOG_DEFAULT}")"
  printf '[]\n' >"${FAUCET_LOG_DEFAULT}"
  printf '[]\n' >"${FAUCET_LOG_LEGACY}"
}

reset_mint_catalog
reset_faucet_logs

log "Ensuring Proof RPC circuits symlink exists"
ln -snf ../circuits "${PROJECT_ROOT}/services/circuits"

if [[ "${using_systemd_validator}" == true ]]; then
  log "Starting validator via systemd (${VALIDATOR_SYSTEMD_SERVICE})"
  systemctl --user start "${VALIDATOR_SYSTEMD_SERVICE}"
else
  log "Starting validator under PM2 (${VALIDATOR_APP})"
  start_pm2_app "${VALIDATOR_APP}" "./scripts/start-private-devnet.sh"
fi

wait_for_rpc

log "RPC ready; pausing before bootstrap to let validator settle"
sleep 20

log "Installing Photon dependencies (npm install --prefix indexer/photon)"
(cd "${PROJECT_ROOT}/indexer/photon" && npm install >/dev/null)

log "Installing Proof RPC dependencies (npm install --prefix services/proof-rpc)"
(cd "${PROJECT_ROOT}/services/proof-rpc" && npm install >/dev/null)

log "Bootstrapping devnet state via bootstrap-private-devnet.ts"
(cd "${PROJECT_ROOT}/web/app" && npx tsx scripts/bootstrap-private-devnet.ts)

log "Building Next.js application (npm run build --prefix web/app)"
(cd "${PROJECT_ROOT}/web/app" && npm run build >/dev/null)

log "Starting Photon indexer (${INDEXER_APP})"
start_pm2_app "${INDEXER_APP}" "npm run start --prefix indexer/photon"

log "Starting Proof RPC (${PROOF_APP})"
start_pm2_app "${PROOF_APP}" "npm run start --prefix services/proof-rpc"

log "Starting Next.js server (${WEB_APP})"
start_pm2_app "${WEB_APP}" "npm run start --prefix web/app"

log "All services launched. Current PM2 status:"
"${PM2_BIN}" list

if [[ "${RUN_SMOKE_TESTS}" == true ]]; then
  wait_for_web
  log "Running wrap/unwrap smoke test (${SMOKE_TEST_SCRIPT})"
  (
    cd "${PROJECT_ROOT}/web/app"
    ZPUMP_TEST_WALLET="${TEST_WALLET_PATH}" \
      RPC_URL="${RPC_URL}" \
      WRAP_COMPUTE_UNIT_LIMIT="${SMOKE_WRAP_COMPUTE_UNIT_LIMIT:-0}" \
      UNWRAP_COMPUTE_UNIT_LIMIT="${SMOKE_UNWRAP_COMPUTE_UNIT_LIMIT:-0}" \
      npx tsx "${SMOKE_TEST_SCRIPT}"
  )
fi

reset_mint_catalog
reset_faucet_logs

log "Reset complete."

