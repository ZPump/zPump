#!/usr/bin/env bash
#
# Starts a long-running local Solana validator that mimics devnet for zPump.
# The script assumes `./scripts/build-all-programs.sh` has been executed so that the
# latest program artifacts live under `target/deploy`.
#
# Usage:
#   scripts/start-private-devnet.sh
# Environment overrides:
#   LEDGER_DIR   - where to persist validator state (default: ~/.local/share/zpump-devnet-ledger)
#   RPC_PORT     - RPC port to expose (default: 8899)
#   FAUCET_PORT  - Faucet port (default: RPC_PORT + 1)
#
# The validator loads the five Anchor programs with fixed program IDs that
# match `Anchor.toml`, so the dApp and bootstrap scripts can connect without
# recompilation.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="${PROGRAM_DIR:-$PROJECT_ROOT/target/deploy}"
LEDGER_DIR="${LEDGER_DIR:-$HOME/.local/share/zpump-devnet-ledger}"
RPC_PORT="${RPC_PORT:-8899}"
# Use an offset to avoid collisions with other local services that might recycle RPC+1.
FAUCET_PORT="${FAUCET_PORT:-$((RPC_PORT + 101))}"
FAUCET_PORT_WAS_SET=false
if [[ -n "${FAUCET_PORT+x}" ]]; then
  FAUCET_PORT_WAS_SET=true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc-port)
      RPC_PORT="$2"
      shift 2
      if [[ "$FAUCET_PORT_WAS_SET" = false ]]; then
        FAUCET_PORT=$((RPC_PORT + 101))
      fi
      ;;
    --faucet-port)
      FAUCET_PORT="$2"
      FAUCET_PORT_WAS_SET=true
      shift 2
      ;;
    *)
      echo "error: unknown argument $1" >&2
      exit 1
      ;;
  esac
done

PROGRAM_FACTORY_PUBKEY="6uruFJACS8n2H28vWA39XqnPwRinL3P1DPLipySZfAuM"
PROGRAM_VAULT_PUBKEY="Cp154M1oxXYJDbrgg9f57ytuthW8X8WNe73NQ7kQQr4Q"
PROGRAM_POOL_PUBKEY="F8bEMyP6Yt3SMGVT9jKL6m13Sn6mc1Z5AeuuJPNCR8to"
PROGRAM_VERIFIER_PUBKEY="geepCeZMrQu1Fh8mXYTxUcZhkw858R2joYXwqRQVS9S"
PROGRAM_DEX_PUBKEY="5Dvt8enX3PgC5hJmzcpB7iuZX6LcYYLP12WXVv7Uef2G"

# Core programs required for shield/unshield/transfer operations
for program in \
  "$PROGRAM_DIR/ptf_factory.so" \
  "$PROGRAM_DIR/ptf_vault.so" \
  "$PROGRAM_DIR/ptf_pool.so" \
  "$PROGRAM_DIR/ptf_verifier_groth16.so"; do
  if [[ ! -f "$program" ]]; then
    echo "error: program artifact not found: $program" >&2
    echo "hint: run './scripts/build-all-programs.sh' before launching the validator." >&2
    exit 1
  fi
done

# ptf_dex is optional (has compilation errors but not needed for core operations)
if [[ ! -f "$PROGRAM_DIR/ptf_dex.so" ]]; then
  echo "warning: ptf_dex.so not found - DEX operations will not be available" >&2
  echo "hint: ptf_dex has compilation errors but is not required for shield/unshield/transfer tests" >&2
fi

mkdir -p "$LEDGER_DIR"
mkdir -p "$LEDGER_DIR/rocksdb"

if pgrep -f solana-test-validator >/dev/null; then
  echo "==> Detected running solana-test-validator instances. Terminating..."
  pkill -f solana-test-validator
  # Allow processes a moment to exit cleanly
  sleep 1
fi

if lsof -i :"$FAUCET_PORT" >/dev/null 2>&1; then
  echo "warning: faucet port $FAUCET_PORT still in use; attempting to free it" >&2
  fuser -k "$FAUCET_PORT"/tcp >/dev/null 2>&1 || true
  sleep 1
fi

echo "==> Starting zPump private devnet"
echo "    Ledger directory : $LEDGER_DIR"
echo "    RPC endpoint     : http://127.0.0.1:$RPC_PORT"
echo "    Faucet endpoint  : http://127.0.0.1:$FAUCET_PORT"
echo

# Build command with optional ptf_dex
VALIDATOR_CMD="solana-test-validator \
  --reset \
  --ledger \"$LEDGER_DIR\" \
  --limit-ledger-size \
  --rpc-port \"$RPC_PORT\" \
  --faucet-port \"$FAUCET_PORT\" \
  --bpf-program \"$PROGRAM_FACTORY_PUBKEY\" \"$PROGRAM_DIR/ptf_factory.so\" \
  --bpf-program \"$PROGRAM_VAULT_PUBKEY\" \"$PROGRAM_DIR/ptf_vault.so\" \
  --bpf-program \"$PROGRAM_POOL_PUBKEY\" \"$PROGRAM_DIR/ptf_pool.so\" \
  --bpf-program \"$PROGRAM_VERIFIER_PUBKEY\" \"$PROGRAM_DIR/ptf_verifier_groth16.so\""

# Add ptf_dex if available
if [[ -f "$PROGRAM_DIR/ptf_dex.so" ]]; then
  VALIDATOR_CMD="$VALIDATOR_CMD --bpf-program \"$PROGRAM_DEX_PUBKEY\" \"$PROGRAM_DIR/ptf_dex.so\""
fi

exec bash -c "$VALIDATOR_CMD"

