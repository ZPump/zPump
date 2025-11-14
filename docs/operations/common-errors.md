# Common Errors & Fixes

This reference lists frequently encountered errors while developing or running zPump, along with root causes and remediation steps.

## On-chain Errors

### `E_ROOT_MISMATCH (0x1790)`
- **Message:** `AnchorError ... Error Code: RootMismatch`
- **Cause:** Pool state and commitment tree roots differ (see [Root Drift](root-drift.md)).
- **Fix:** Reset validator ledger, clear Photon snapshot, rerun bootstrap, publish new roots.

### `E_INSUFFICIENT_LIQUIDITY (0x1779)`
- **Message:** `AnchorError thrown ... Error Code: InsufficientLiquidity`
- **Cause:** Unshield attempts to withdraw more than was deposited. Often happens when wrap deposited only the desired amount but proof expects amount+fee.
- **Fix:** Ensure wrap deposits `noteAmount` (amount + fee). The wrap/unwrap script handles this automatically; update client code if needed.

### `AccountBorrowFailed`
- **Cause:** Borrowed the same account mutably twice within `ptf_pool::unshield`. Previously triggered when CPIs were invoked without dropping the pool state borrow.
- **Fix:** Code now caches fields and drops the borrow before CPI. If reintroducing mutable borrows, ensure they’re released before additional loads.

### `ConstraintMut` / `AccountOwnedByWrongProgram`
- **Message:** Anchor constraint violations involving `twin_mint`.
- **Cause:** Passing incorrect optional account meta for `Option<Account>` fields. Anchor requires the slot to exist; when absent set to program ID.
- **Fix:** SDK pushes placeholder (`POOL_PROGRAM_ID`) when twin mint not used. Ensure custom clients replicate this pattern.

### `Transaction too large: > 1232 bytes`
- **Cause:** Instruction account list + data exceed Solana transaction size limit.
- **Fix:** Use Address Lookup Tables (ALTs). Bootstrap script provisions them and stores addresses in `mints.generated.json`. Ensure frontend passes `lookupTable` to `unwrapSdk`.

## Proof / Canonicalisation Errors

### `PublicInputMismatch`
- **Message:** `PoolError::PublicInputMismatch`.
- **Causes:**
  - Proof RPC misinterpreting decimal strings as hex (fixed by `normalizeBigInt`).
  - Amount/fee conversions using wrong scaling.
  - Destination/pool/mint fields not canonicalised.
- **Fix:** Ensure canonical big-endian hex strings are converted to little-endian bytes before sending on-chain. Use SDK utilities (`canonicalizeHex`, `canonicalHexToBytesLE`).

### `Shield proof mismatch` logs
- **Cause:** Debug logs show old/new roots not matching commitment tree. Usually indexer snapshot is stale.
- **Fix:** Hard refresh UI, ensure Photon is updated (`publishRoots`). If mismatch persists, perform root drift recovery.

## Frontend Issues

### `Commitment tree account missing on-chain`
- **Cause:** Bootstrap not run or referencing stale mint catalogue.
- **Fix:** Run `bootstrap-private-devnet.ts`, rebuild Next.js (`npm run build`), restart `ptf-web`.

### Shielding Spinner Never Finishes
- **Cause:** UI awaited indexer balance adjustment; if Photon call fails, spinner persisted.
- **Fix:** `ConvertForm` now wraps `indexerClient.adjustBalance` in `try/catch`. If this recurs, check indexer logs for `404 not_enabled` (when `ENABLE_BALANCE_API=false`).

### Faucet Not Responding
- **Symptoms:** Airdrop requests hang.
- **Cause:** Old validator still bound to faucet port (`8899/8900`).
- **Fix:** `pkill -f solana-test-validator`, restart via script (which also frees the faucet port).

## Service Errors

### Photon `invalid_hex`
- **Cause:** Client posted base58 mint keys instead of canonical hex.
- **Fix:** Ensure callers use SDK’s `canonicalizeHex`. The Convert form does this before publishing roots.

### Proof RPC Timeout
- **Cause:** `snarkjs` proof generation heavy; if service overloaded or verifying keys missing, requests can hang.
- **Fix:** Check `services/proof-rpc/logs`. Verify verifying keys exist (`circuits/keys`), restart service.

### `mint_not_found` from Photon
- **Cause:** Root not yet published. After bootstrap or ledger reset, Photon may not know about the mint.
- **Fix:** Wrap once (script or UI) to publish root, or manually POST to `/roots/:mint`.

## Validator-Level Issues

### `Error: Transaction simulation failed: exceeded CUs meter`
- **Cause:** Missing compute budget instruction, stale SDK (still attempting the single-instruction wrap), or a custom build that reintroduced heavy logging.
- **Fix:** Ensure the SDK submits the four-step wrap pipeline, keep `ComputeBudgetProgram.setComputeUnitLimit` at the top of each transaction, and avoid re-enabling `sol_log_compute_units` in production. If you intentionally toggle the `lightweight` flag, remember to revert before running end-to-end tests.

### `Program failed to complete. Logs: memory allocation failed`
- **Cause:** Running with old Solana runtime settings or using large instruction data.
- **Fix:** Ensure build removes unused data (e.g. avoid sending redundant root bytes). The project already trimmed shield args.

## Reporting & Debugging

- Use `solana logs -u localhost` to tail validator logs.
- For frontend debugging, set `NEXT_PUBLIC_DEBUG_WRAP=true`.
- When creating new documentation entries, link back here for quick reference.

