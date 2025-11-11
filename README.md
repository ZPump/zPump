# zPump

A Solana zero-knowledge privacy exchange stack: Anchor programs (`factory`, `vault`, `pool`, `verifier`), proof services, indexer hooks, and a Next.js dApp capable of running against a local “simnet” or live clusters.

---

## 1. Project Structure

```
programs/               # Anchor workspace (factory, vault, pool, verifier-groth16)
docs/                   # Product+protocol specs
services/proof-rpc/     # Stateless proof builder (Groth16)
indexer/photon/         # Optional roots/nullifiers indexer
web/app/                # Next.js front-end (simulation wallet + faucet)
tests/program-test-harness/  # Solana program-test harness (Branch A)
scripts/                # Dev automation (build/test bootstrap)
```

Key reference: `docs/solana-privacy-twin-factory-spec-v0.5.md`

---

## 2. Required Tooling

All components run directly on the host (no Docker):

| Component | Version | Notes |
|-----------|---------|-------|
| Rust | 1.78+ | `rustup toolchain install stable` |
| Anchor CLI | 0.32.1 | `cargo install --git https://github.com/coral-xyz/anchor --tag v0.32.1 anchor-cli` |
| Solana CLI | 2.3.2 | `sh -c "$(curl -sSfL https://release.solana.com/v2.3.2/install)"` then `solana config set -u localhost` |
| Node.js | 18.x | for web app & proof service |
| pnpm (optional) | 8.x | faster JS installs |
| sccache (optional) | | speeds up `anchor build` |
| tmux / systemd (optional) | | keep validator & services running |

---

## 3. Simnet (Local Validator) Workflow

1. **Build Solana programs**
   ```bash
   anchor build --no-idl
   ```
   Produces `.so` artifacts under `target/deploy/`.

2. **Start local validator** (separate shell/tmux pane)
   ```bash
   solana-test-validator \
     --ledger ~/.zpump-ledger \
     --reset \
     --limit-ledger-size \
     --bpf-program 4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy target/deploy/ptf_factory.so \
     --bpf-program 9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh target/deploy/ptf_vault.so \
     --bpf-program 4Tx3v6is7qeVjdHvL3a16ggB9VVMBPVhpPSkUGoXZhre target/deploy/ptf_pool.so \
     --bpf-program Gm2KXvGhWrEeYERh3sxs1gwffMXeajVQXqY7CcBpm7Ua target/deploy/ptf_verifier_groth16.so
   ```
   > Optionally preload test mints with `--account` flags.

3. **Bootstrap programs + verifying keys**
   ```bash
   cd web/app
   npm install
   npm run bootstrap:devnet
   ```
   This script registers the factory, initializes vaults/pools, uploads Groth16 verifying keys for `shield`/`unshield`, and refreshes `config/mints.generated.json` with real mint + pool PDAs.

4. **Proof RPC service**
   ```bash
   cd services/proof-rpc
   npm install
   npm run build
   RPC_PORT=8787 npm start
   ```

5. **Indexer** *(optional until private transfers go live)*  
   Bring up `indexer/photon` to expose `/roots`, `/nullifiers` to the dApp.

6. **Next.js dApp**
   ```bash
   cd web/app
   npm install
   NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899 \
   NEXT_PUBLIC_PROOF_RPC_URL=http://127.0.0.1:8787 \
   NEXT_PUBLIC_FAUCET_MODE=local \
   npm run dev
   ```
   - Set `FAUCET_MODE=local` (and optionally `FAUCET_KEYPAIR=/path/to/id.json`) in your server environment so the `/api/faucet/*` routes can mint against the local validator.
   - When targeting public devnet/testnet/mainnet, omit these variables so the faucet hides itself and relies on existing tokens.

---

### 3.1 Private Devnet (Server) Workflow

To avoid public devnet faucet throttling, run a persistent validator that mirrors the same program IDs:

1. **Ensure artifacts are built**
   ```bash
   anchor build --no-idl
   ```

2. **Start the validator**
   ```bash
   scripts/start-private-devnet.sh
   ```
   - Uses `~/.local/share/zpump-devnet-ledger` by default.
   - Exposes RPC on `http://127.0.0.1:8899`. Override with `RPC_PORT`.
   - Loads the four Anchor programs with fixed IDs so the dApp and scripts operate unchanged.

3. **Bootstrap on-chain state**
   ```bash
   cd web/app
   npm run bootstrap:devnet
   ```
   The script is idempotent—rerun any time you reset the ledger to recreate mint metadata, verifying keys, and vault accounts.

4. **Point services at the private cluster**
   - `NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899` for the dApp.
   - Proof RPC: `RPC_URL=http://127.0.0.1:8899`.
   - Update `.env` files accordingly.

Once flows are validated here, target the same binaries at public devnet/mainnet.

---

## 4. Testing

### 4.1 Rust / On-chain
- **Unit tests** (no network)
  ```bash
  cargo test --offline
  ```

- **Branch A program-test harness**
  ```bash
  anchor build
  cargo test -p program-test-harness -- --ignored
  ```
  or
  ```bash
  scripts/run-local-ci.sh
  ```

### 4.2 Front-end / Services
- `web/app`:
  - `npm run lint`
  - `npm run test`
  - `npm run dev`
- `tests/e2e`:
  ```bash
  cd tests/e2e
  npm install
  npx playwright test
  ```
- `services/proof-rpc`:
  - `npm run lint`
  - `npm run test` *(add once spec’d)*
  - `npm run dev`

---

## 5. Front-end to On-chain Integration

- The dApp currently features:
- **Simulation wallet** for power users that want burner accounts entirely in-browser.
- **Local validator faucet** (when `FAUCET_MODE=local`) that airdrops SOL and mints origin tokens against the bootstrap mint authority. In other environments the faucet hides itself and expects existing tokens.
- **Convert** flow hooked to the live SDK with Proof RPC integration (shield, unshield to origin/twin, change notes).
- **Vault dashboard** (`/vault`) showing on-chain mint supply and vault balances after bootstrap

### Immediate Next Steps
1. Harden the Proof RPC surface (metrics, rate limiting, operational alarms).
2. Document governance playbooks for enabling PTkn redemption on shared devnets/mainnet.
3. Build optional public-network faucet tooling once testnet/mainnet partners define funding sources.

### Planned Upgrades After Simnet Validation
- Investigate optional backend transaction builder (Option 2) for caching & UX.
- Bring Photon indexer online to surface roots/nullifiers in UI.
- Automate program bootstrap via `scripts/bootstrap-simnet.ts`.
- Extend Cypress/Jest suites for shield→unshield happy path.
- Evaluate Docker compose once bare-metal workflow is stable (user request: avoid Docker today).

These notes capture future enhancements; implement after the simnet path is proven end-to-end.

---

## 6. Environment Variables

| Location | Variable | Purpose | Default |
|----------|----------|---------|---------|
| web/app | `NEXT_PUBLIC_RPC_URL` | Solana RPC endpoint | `http://127.0.0.1:8899` |
| web/app | `NEXT_PUBLIC_PROOF_RPC_URL` | Proof RPC endpoint | `http://127.0.0.1:8787` |
| web/app | `NEXT_PUBLIC_INDEXER_URL` | Photon indexer endpoint | `http://127.0.0.1:8787` |
| web/app | `NEXT_PUBLIC_FAUCET_MODE` | `local` to enable validator faucet, `simulation`/unset otherwise | `simulation` |
| web/app | `NEXT_PUBLIC_ENABLE_BURNER` | `true` to expose UnsafeBurner wallet (local only) | `false` |
| web/app | `NEXT_PUBLIC_CLUSTER` *(planned)* | `localnet` / `devnet` / `mainnet` | – |
| backend | `RPC_URL` | Solana RPC endpoint for proof/indexer services | `http://127.0.0.1:8899` |
| backend | `PHOTON_URL` | Upstream Photon/Helius endpoint (optional) | – |
| services/proof-rpc | `RPC_PORT` | HTTP port | `8787` |
| services/proof-rpc | `GROTH16_DIR` *(planned)* | Verifying key path | `config/verifying-keys.json` |
| services/faucet | `FAUCET_MODE` | `local` to enable mint/airdrop helpers | `disabled` |
| services/faucet | `FAUCET_KEYPAIR` | Authority keypair path (defaults to `~/.config/solana/id.json`) | – |
| services/faucet | `FAUCET_RPC_URL` | Override RPC endpoint for faucet | Inherits `RPC_URL` |

Add `.env.example` once values are finalized.

---

## 7. Contributing

1. Ensure toolchain versions match §2.
2. Format Rust (`cargo fmt`) and TypeScript (`npm run lint`) before PRs.
3. Run `scripts/run-local-ci.sh` to verify programs before pushing.
4. Document any spec deviations in `docs/solana-privacy-twin-factory-spec-v0.5.md`.

---

## 8. Release Targets

| Milestone | Description |
|-----------|-------------|
| **Simnet** | Validator + programs + dApp + proof RPC all local. Primary focus right now. |
| **Private Devnet** *(in progress)* | Long-lived validator on shared server using `scripts/start-private-devnet.sh`; mirrors program IDs for end-to-end rehearsals. |
| **Devnet** *(planned)* | Deploy same binaries to public devnet once private devnet passes E2E tests. |
| **Mainnet Guarded** *(future)* | Governance-controlled launch, cap supply, enable hooks selectively. |
| **Relayer Interface** *(future)* | Optional service once private transfer audits clear. |

This README will evolve as we lock each stage. Feel free to open issues/PRs with clarifications or new automation scripts.
