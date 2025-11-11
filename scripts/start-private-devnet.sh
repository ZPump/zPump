#!/usr/bin/env bash
#
# Starts a long-running local Solana validator that mimics devnet for zPump.
# The script assumes `anchor build --no-idl` has been executed so that the
# latest program artifacts live under `target/deploy`.
#
# Usage:
#   scripts/start-private-devnet.sh
# Environment overrides:
#   LEDGER_DIR   - where to persist validator state (default: ~/.local/share/zpump-devnet-ledger)
#   RPC_PORT     - RPC port to expose (default: 8899)
#   FAUCET_PORT  - Faucet port (default: RPC_PORT + 1)
#
# The validator loads the four Anchor programs with fixed program IDs that
# match `Anchor.toml`, so the dApp and bootstrap scripts can connect without
# recompilation.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="${PROGRAM_DIR:-$PROJECT_ROOT/target/deploy}"
LEDGER_DIR="${LEDGER_DIR:-$HOME/.local/share/zpump-devnet-ledger}"
RPC_PORT="${RPC_PORT:-8899}"
FAUCET_PORT="${FAUCET_PORT:-$((RPC_PORT + 1))}"

PROGRAM_FACTORY_PUBKEY="4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy"
PROGRAM_VAULT_PUBKEY="9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh"
PROGRAM_POOL_PUBKEY="4Tx3v6is7qeVjdHvL3a16ggB9VVMBPVhpPSkUGoXZhre"
PROGRAM_VERIFIER_PUBKEY="Gm2KXvGhWrEeYERh3sxs1gwffMXeajVQXqY7CcBpm7Ua"

for program in \
  "$PROGRAM_DIR/ptf_factory.so" \
  "$PROGRAM_DIR/ptf_vault.so" \
  "$PROGRAM_DIR/ptf_pool.so" \
  "$PROGRAM_DIR/ptf_verifier_groth16.so"; do
  if [[ ! -f "$program" ]]; then
    echo "error: program artifact not found: $program" >&2
    echo "hint: run 'anchor build --no-idl' before launching the validator." >&2
    exit 1
  fi
done

mkdir -p "$LEDGER_DIR"

echo "==> Starting zPump private devnet"
echo "    Ledger directory : $LEDGER_DIR"
echo "    RPC endpoint     : http://127.0.0.1:$RPC_PORT"
echo "    Faucet endpoint  : http://127.0.0.1:$FAUCET_PORT"
echo

exec solana-test-validator \
  --reset \
  --ledger "$LEDGER_DIR" \
  --limit-ledger-size \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$FAUCET_PORT" \
  --bpf-program "$PROGRAM_FACTORY_PUBKEY" "$PROGRAM_DIR/ptf_factory.so" \
  --bpf-program "$PROGRAM_VAULT_PUBKEY" "$PROGRAM_DIR/ptf_vault.so" \
  --bpf-program "$PROGRAM_POOL_PUBKEY" "$PROGRAM_DIR/ptf_pool.so" \
  --bpf-program "$PROGRAM_VERIFIER_PUBKEY" "$PROGRAM_DIR/ptf_verifier_groth16.so"

