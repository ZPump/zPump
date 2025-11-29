#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-${PROJECT_ROOT}/.test-logs}"
RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
SKIP_ANCHOR="${SKIP_ANCHOR_TESTS:-false}"
SKIP_BUILD="${SKIP_BUILD_DEPLOY:-false}"
SKIP_RESET="${SKIP_RESET:-false}"
SKIP_LOW="${SKIP_LOWLEVEL:-false}"
SKIP_HIGH="${SKIP_HIGHLEVEL:-false}"
SKIP_MINT_REG="${SKIP_MINT_REG:-false}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
PASSED=0; FAILED=0; SKIPPED=0

mkdir -p "${LOG_DIR}"
log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "${LOG_DIR}/test-suite.log"; }
log_success() { printf "${GREEN}✓${NC} %s\n" "$*"; log "$*"; PASSED=$((PASSED + 1)); }
log_error() { printf "${RED}✗${NC} %s\n" "$*" >&2; log "ERROR: $*"; FAILED=$((FAILED + 1)); }
log_skip() { printf "${YELLOW}⊘${NC} %s\n" "$*"; log "SKIPPED: $*"; SKIPPED=$((SKIPPED + 1)); }
log_section() { echo ""; printf "${BOLD}${CYAN}━━━ %s ━━━${NC}\n" "$*"; log "SECTION: $*"; }

run_test() {
  local name="$1"; shift
  log_section "$name"
  if "$@" 2>&1 | tee -a "${LOG_DIR}/${name// /-}.log"; then
    log_success "$name completed"
    return 0
  else
    log_error "$name failed (check ${LOG_DIR}/${name// /-}.log)"
    return 1
  fi
}

cd "${PROJECT_ROOT}"

printf "${BOLD}${BLUE}"
cat << 'EOF'
╔═══════════════════════════════════════════════════════════════╗
║          zPump Full Test Suite                                 ║
╚═══════════════════════════════════════════════════════════════╝
EOF
printf "${NC}"

log "Starting full test suite at $(date)"

# Order: Reset first (clean state), then build/deploy, then tests
if [[ "${SKIP_RESET}" != "true" ]]; then
  RUN_SMOKE_TESTS=false run_test "Reset and Bootstrap" "${PROJECT_ROOT}/scripts/reset-dev-env.sh" || exit 1
else
  log_skip "Reset and Bootstrap"
fi

if [[ "${SKIP_BUILD}" != "true" ]]; then
  run_test "Build and Deploy" "${PROJECT_ROOT}/scripts/build-and-deploy.sh" || exit 1
else
  log_skip "Build and Deploy"
fi

if [[ "${SKIP_ANCHOR}" != "true" ]]; then
  run_test "Anchor Tests" "${PROJECT_ROOT}/scripts/run-anchor-tests.sh" || exit 1
else
  log_skip "Anchor Tests"
fi

if [[ "${SKIP_LOW}" != "true" ]]; then
  run_test "Low-Level E2E" npx tsx web/app/scripts/lowlevel-e2e.ts || exit 1
else
  log_skip "Low-Level E2E"
fi

if [[ "${SKIP_DEX_LOW:-false}" != "true" ]]; then
  run_test "DEX Low-Level E2E" npx tsx web/app/scripts/dex-lowlevel-e2e.ts || exit 1
else
  log_skip "DEX Low-Level E2E"
fi

if [[ "${SKIP_HIGH}" != "true" ]]; then
  run_test "High-Level E2E" npx tsx web/app/scripts/browser-e2e.ts || exit 1
else
  log_skip "High-Level E2E"
fi

if [[ "${SKIP_DEX_HIGH:-false}" != "true" ]]; then
  run_test "DEX High-Level E2E" npx tsx web/app/scripts/dex-highlevel-e2e.ts || exit 1
else
  log_skip "DEX High-Level E2E"
fi

if [[ "${SKIP_MINT_REG}" != "true" ]]; then
  run_test "Mint Registration Reliability" npx tsx web/app/scripts/test-mint-registration.ts || exit 1
else
  log_skip "Mint Registration Reliability"
fi

log_section "Test Summary"
printf "${GREEN}Passed: ${PASSED}${NC} | ${RED}Failed: ${FAILED}${NC} | ${YELLOW}Skipped: ${SKIPPED}${NC}\n"
log "Test suite completed: Passed=${PASSED} Failed=${FAILED} Skipped=${SKIPPED}"

if [[ ${FAILED} -gt 0 ]]; then
  log_error "Test suite failed with ${FAILED} failures"
  exit 1
fi

log_success "All tests passed!"
exit 0
