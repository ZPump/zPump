# Bootstrapping the Private Devnet

This guide walks through starting a local Solana validator with the zPump programs deployed, running supporting services, and verifying the shielding workflow end-to-end.

## 1. Clean Start (Optional but Recommended)

If you previously ran the devnet, stop and clean up to avoid root drift:

```bash
./scripts/reset-dev-env.sh
```

The script performs the full reset:
- Stops all PM2 services and the `zpump-devnet` systemd unit if it is active.
- Wipes the ledger at `~/.local/share/zpump-devnet-ledger` and resets Photon snapshots.
- Re-establishes required symlinks (`services/circuits -> ../circuits`).
- Restarts the validator via systemd (falling back to PM2 if the service is not installed), waits for RPC health, reinstalls Photon/Proof RPC deps, reruns the bootstrap script, relaunches `ptf-indexer`, `ptf-proof`, and `ptf-web` under PM2, and executes the wrap/unwrap smoke test (`npx tsx scripts/wrap-unwrap-local.ts`) to verify register/mint/shield/unshield flows. Export `RUN_SMOKE_TESTS=false` to skip the smoke test.
- Clears both wallet-activity logs: the local helper file at `web/app/wallet-activity.json` and the Photon snapshot (which now stores private-mode history keyed by viewing IDs) so that switching between modes always starts from a clean slate.

This one-shot reset prevents mismatched commitment tree and pool roots (see [Root Drift Playbook](../operations/root-drift.md)).

## 2. Launch Local Validator

The repo ships a user-level systemd unit (`scripts/systemd/zpump-devnet.service`) that keeps `solana-test-validator` online. Install/enable it once:

```bash
mkdir -p ~/.config/systemd/user
cp scripts/systemd/zpump-devnet.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zpump-devnet
journalctl --user -u zpump-devnet -f    # tail validator logs
```

`./scripts/reset-dev-env.sh` will stop/start this unit automatically. If you prefer to run the validator manually (e.g. for CI), invoke `./scripts/start-private-devnet.sh` which terminates lingering validators, frees the faucet port, and execs `solana-test-validator` with the Anchor program IDs.

## 3. Bootstrap On-chain State

In a new terminal:

```bash
npx tsx web/app/scripts/bootstrap-private-devnet.ts
```

What the script does:
- Loads verifying keys from `circuits/keys` and registers them with `ptf_verifier_groth16`.
- Creates origin mints (USDC, SOLx by default) and twin mints.
- Initialises `ptf_factory`, `ptf_vault`, and `ptf_pool` PDAs.
- Seeds commitment tree, note ledger, nullifier set.
- Creates Address Lookup Tables (ALTs) for unwrap transactions.
- Writes `web/app/config/mints.generated.json`.
- Publishes initial roots to Photon (via `/roots/:mint`).

If the script errors with “account missing”, rerun—validator may need a few seconds to load programs.

## 4. Build Frontend & Restart Services

After bootstrap, rebuild and restart to pick up new configuration:

```bash
cd web/app
npm run build
cd ../..
pm2 restart ptf-web --update-env
pm2 restart ptf-indexer --update-env
pm2 restart ptf-proof --update-env
```

Ensure pm2 processes exist; if not, start them:

```bash
pm2 start ecosystem.config.js
```

### Registering additional mints

After the reset you can bring new test assets online directly from the faucet UI (or via `POST /api/mints`). Each request provisions a fresh origin mint, registers it with `ptf_factory`, initializes the vault/pool/commitment tree, publishes the root to the indexer, and updates `web/app/config/mints.generated.json`. Once the flow completes (typically <60s on a local devnet) the new mint shows up automatically in the faucet, convert form, vault dashboard, and wallet drawer—no rebuild required.

## 5. Frontend Access

- Open the Convert page (default `http://localhost:3000/convert`).
- If using the bundled simulation wallet, connect via the in-browser wallet provider.
- For real wallets (e.g. Phantom) ensure the RPC endpoint is reachable (tunnel or LAN).

### Wallet activity modes

Use the `NEXT_PUBLIC_WALLET_ACTIVITY_MODE` (and matching server-side `WALLET_ACTIVITY_MODE`) env var to pick how conversion history is recorded. We now default to the **private** path:

- `private` (default): the client derives a deterministic viewing key from the wallet secret, hashes it into a viewing ID, and stores activity inside the Photon indexer (`/activity/:viewId`). Only the hashed viewing ID ever leaves the browser. The wallet drawer fetches history through `/api/indexer/activity/[viewId]` and decrypts everything client-side.
- `local`: successful wrap/unwraps are written to `web/app/wallet-activity.json` via the existing Next API, which is convenient for demos but exposes entries to anyone with filesystem/API access. Enable this only if you explicitly set both env vars to `local` before building.

`./scripts/reset-dev-env.sh` wipes the helper JSON file *and* the Photon snapshot, so toggling modes or re-running the smoke test won’t leak stale history between modes.

## 6. Faucet Usage

- Visit `/faucet`.
- Request SOL (defaults to 1 SOL).
- Mint origin tokens (USDC) directly into the wallet ATA.
- Faucet logs are stored in `web/app/faucet-events.json`.

## 7. Comprehensive Browser-Style E2E Test

For day-to-day regressions we now ship a single script that mirrors the user journey end-to-end:

```bash
npx tsx web/app/scripts/browser-e2e.ts
```

Scenario coverage:

- Registers a fresh mint via the same `/api/mints` endpoint the faucet uses, publishes roots to the Photon indexer, and keeps the commitment tree/current root in sync after every transaction.
- Faucets SOL/origin tokens through `/api/faucet`, shields multiple notes (different sizes), and stores the resulting commitments locally so the wallet drawer logic can be simulated.
- Performs a multi-note private transfer with change to another wallet, then intentionally attempts nullifier reuse (both transfer and unshield) to ensure the pool rejects stale notes exactly as the UI would surface.
- Executes a partial unshield with automatic change, immediately re-shields part of the public balance to force note rewriting.
- Approves an allowance PDA, mirrors it into the Photon `/allowances` store, exercises `transfer_from` as a delegate, and revokes the allowance to confirm delegated spending obeys SPL semantics.
- Fetches viewing-key notes, balances, and activity logs from the indexer so we can assert the browser’s private mode still renders history correctly.
- Logs every step with the same `"[wrap]" / "[transfer]" / "[unwrap]"` prefixes you see in the browser console, finishing with `[done] full browser-style E2E flow completed successfully`.

Environment overrides (optional):

- `RPC_URL`, `PROOF_URL`, `INDEXER_PROXY_URL`, `NEXT_URL`, `FAUCET_URL`, `MINTS_API_URL` — point the script at remote infrastructure instead of localhost.
- `SOL_AIRDROP_LAMPORTS`, `WRAP_AMOUNT`, `MINT_DECIMALS` — adjust faucet sizes and precision for stress tests.

Use this script after any change that touches shielding, transfers, allowances, Photon APIs, or wallet-derived viewing keys—the flow will fail fast with the same Anchor errors the frontend would expose if something regresses.

## 8. Indexer Validation

Check Photon root endpoint:
```bash
curl -s http://127.0.0.1:8787/roots/<originMint>
```

Replace `<originMint>` with the current mint from `mints.generated.json`. Output should include the latest root published after wrap.

## 9. Shut Down

To stop services cleanly:

```bash
pm2 stop ptf-web ptf-indexer ptf-proof
systemctl --user stop zpump-devnet  # or pkill -f solana-test-validator
```

Consider persisting PM2 state (`pm2 save`) if using system startup.

## Troubleshooting

- **`E_ROOT_MISMATCH` after restart:** Pool and commitment tree roots diverged. Follow the clean start steps above.
- **Indexer returns 404 `mint_not_found`:** Bootstrap may not have published the root. Run the wrap script or manually POST the root to `/roots/:mint`.
- **Proof generation errors:** Ensure verifying key files exist (`circuits/keys/<circuit>.json`) and `g16` artifacts were generated.
- **Transaction too large:** ALTs should mitigate this. Re-run bootstrap to ensure tables were created and `lookupTable` entries exist in `mints.generated.json`.

Proceed to [CI & Testing](ci-testing.md) for automated validation guidance.

