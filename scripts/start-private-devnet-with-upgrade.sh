#!/usr/bin/env bash
#
# Starts a local Solana validator and deploys programs with upgrade authority.
# This allows programs to be upgraded for testing purposes.
#
# Usage:
#   scripts/start-private-devnet-with-upgrade.sh
# Environment overrides:
#   LEDGER_DIR   - where to persist validator state (default: ~/.local/share/zpump-devnet-ledger)
#   RPC_PORT     - RPC port to expose (default: 8899)
#   FAUCET_PORT  - Faucet port (default: RPC_PORT + 101)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="${PROGRAM_DIR:-$PROJECT_ROOT/target/deploy}"
LEDGER_DIR="${LEDGER_DIR:-$HOME/.local/share/zpump-devnet-ledger}"
RPC_PORT="${RPC_PORT:-8899}"
FAUCET_PORT="${FAUCET_PORT:-$((RPC_PORT + 101))}"

# Create upgrade authority keypair if it doesn't exist
UPGRADE_AUTH_FILE="$PROJECT_ROOT/tmp/upgrade-authority.json"
mkdir -p "$PROJECT_ROOT/tmp"
if [[ ! -f "$UPGRADE_AUTH_FILE" ]]; then
    solana-keygen new --outfile "$UPGRADE_AUTH_FILE" --no-bip39-passphrase --force > /dev/null 2>&1
fi
UPGRADE_AUTH=$(solana-keygen pubkey "$UPGRADE_AUTH_FILE")

# Start validator without loading programs
mkdir -p "$LEDGER_DIR"
if pgrep -f solana-test-validator >/dev/null; then
    echo "==> Stopping existing validator..."
    pkill -f solana-test-validator
    sleep 2
fi

echo "==> Starting validator without programs..."
solana-test-validator \
  --reset \
  --ledger "$LEDGER_DIR" \
  --limit-ledger-size \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$FAUCET_PORT" \
  > /dev/null 2>&1 &

VALIDATOR_PID=$!
echo "==> Validator started (PID: $VALIDATOR_PID)"

# Wait for validator to be ready
echo "==> Waiting for validator to be ready..."
sleep 8

# Airdrop SOL to upgrade authority
echo "==> Funding upgrade authority..."
solana airdrop 10 "$UPGRADE_AUTH" --url "http://127.0.0.1:$RPC_PORT" > /dev/null 2>&1 || true

# Deploy programs with upgrade authority
echo "==> Deploying programs with upgrade authority..."
for program in ptf_factory ptf_vault ptf_verifier_groth16 ptf_pool; do
    if [[ -f "$PROGRAM_DIR/$program.so" ]]; then
        echo "  Deploying $program..."
        if solana program deploy \
          "$PROGRAM_DIR/$program.so" \
          --url "http://127.0.0.1:$RPC_PORT" \
          --program-id "$PROGRAM_DIR/$program-keypair.json" \
          --upgrade-authority "$UPGRADE_AUTH_FILE" \
          2>&1 | tee /tmp/deploy-$program.log; then
            echo "    ✓ $program deployed successfully"
        else
            echo "    ✗ Failed to deploy $program (check /tmp/deploy-$program.log)"
        fi
    fi
done

echo "==> Validator ready!"
echo "    RPC endpoint     : http://127.0.0.1:$RPC_PORT"
echo "    Faucet endpoint  : http://127.0.0.1:$FAUCET_PORT"
echo "    Upgrade authority: $UPGRADE_AUTH"
echo ""
echo "Press Ctrl+C to stop the validator"

# Wait for validator process
wait $VALIDATOR_PID

