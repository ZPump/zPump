# Bootstrapping the Private Devnet

This guide walks through starting a local Solana validator with the zPump programs deployed, running supporting services, and verifying the shielding workflow end-to-end.

## 1. Clean Start (Optional but Recommended)

If you previously ran the devnet, stop and clean up to avoid root drift:

```bash
pkill -f solana-test-validator || true
rm -rf ~/.local/share/zpump-devnet-ledger
rm -f indexer/photon/data/state.json
```

This prevents mismatched commitment tree and pool roots (see [Root Drift Playbook](../operations/root-drift.md)).

## 2. Launch Local Validator

```bash
./scripts/start-private-devnet.sh
```

Script behaviour:
- Kills any lingering validator.
- Ensures faucet port is free.
- Starts `solana-test-validator` with the program binaries and accounts specified in `Anchor.toml`.
- Runs in foreground; leave it running. For PM2 integration, wrap the script or use a custom service definition.

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
pm2 start ecosystem.config.cjs   # example, adjust when config is defined
```

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
- Generates a new keypair (or reuses one at `/tmp/zpump-test.json`).
- Requests SOL + USDC from faucet.
- Fetches commitment tree root from Photon (fallback to chain) and publishes to indexer.
- Calls Proof RPC for wrap/unshield proofs.
- Submits wrap transaction, waits for confirmation.
- Publishes new root to indexer.
- Submits unwrap transaction, waits for confirmation.

Verify the script ends with `[done] wrap and unwrap flow completed successfully`.

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
pkill -f solana-test-validator
```

Consider persisting PM2 state (`pm2 save`) if using system startup.

## Troubleshooting

- **`E_ROOT_MISMATCH` after restart:** Pool and commitment tree roots diverged. Follow the clean start steps above.
- **Indexer returns 404 `mint_not_found`:** Bootstrap may not have published the root. Run the wrap script or manually POST the root to `/roots/:mint`.
- **Proof generation errors:** Ensure verifying key files exist (`circuits/keys/<circuit>.json`) and `g16` artifacts were generated.
- **Transaction too large:** ALTs should mitigate this. Re-run bootstrap to ensure tables were created and `lookupTable` entries exist in `mints.generated.json`.

Proceed to [CI & Testing](ci-testing.md) for automated validation guidance.

