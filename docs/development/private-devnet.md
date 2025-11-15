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

## 6. Faucet Usage

- Visit `/faucet`.
- Request SOL (defaults to 1 SOL).
- Mint origin tokens (USDC) directly into the wallet ATA.
- Faucet logs are stored in `web/app/faucet-events.json`.

## 7. End-to-End Wrap/Unwrap Test

Run the script:
```bash
npx tsx web/app/scripts/wrap-unwrap-local.ts
```

Behaviour:
- Uses the wallet at `~/.config/solana/id.json` by default (override via `ZPUMP_TEST_WALLET`).
- Requests SOL + USDC from faucet.
- Fetches commitment tree root from Photon (fallback to chain) and publishes to indexer.
- Calls Proof RPC for wrap/unshield proofs.
- Submits wrap transaction, waits for confirmation.
- Publishes new root to indexer.
- Submits unwrap transaction, waits for confirmation.

Verify the script ends with `[done] wrap and unwrap flow completed successfully`.

> `./scripts/reset-dev-env.sh` runs this script automatically unless `RUN_SMOKE_TESTS=false` is set.

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

