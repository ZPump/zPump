# Troubleshooting: Root Drift (`E_ROOT_MISMATCH`)

`E_ROOT_MISMATCH` is the most common failure when shielding. It occurs when the pool state and the commitment tree PDAs disagree about the current Merkle root. This guide explains symptoms, root causes, detection, and recovery.

## Symptoms

- Wrap (shield) transactions fail with:
  ```
  custom program error: 0x1790
  AnchorError ... Error Code: RootMismatch (E_ROOT_MISMATCH)
  ```
- Frontend debug logs (`NEXT_PUBLIC_DEBUG_WRAP=true`) show the current root from the pool or indexer diverging from the commitment tree root.
- Photon root endpoint returns a different value than the pool account.

## Root Cause

`ptf_pool::shield` executes:
```rust
require!(
    commitment_tree_data.current_root == pool_state.current_root,
    PoolError::RootMismatch,
);
```

During normal execution both roots are updated atomically: pool state first, then commitment tree (or vice versa) within the same transaction. However, on a local validator:

1. **Validator crash / forced kill:** If `solana-test-validator` is terminated between writing the pool state and commitment tree updates, the pool account may persist the new root while the tree rolls back to the previous root.
2. **Incomplete bootstrap:** Re-running the bootstrap script on a dirty ledger can recreate the pool state with a new root but leave the old commitment tree in place.
3. **Indexer desynchronisation:** Even if the chain updates correctly, Photon may still serve the old root. The frontend now republishes roots to Photon to mitigate this, but stale snapshots can introduce confusion.

## Diagnosis

1. **Check on-chain values:**
   ```bash
   # Pool account
   npx tsx -e "import { Connection, PublicKey } from '@solana/web3.js'; import { bytesLEToCanonicalHex } from './web/app/lib/onchain/utils'; (async () => { const conn = new Connection('http://127.0.0.1:8899','confirmed'); const pool = new PublicKey('<poolId>'); const info = await conn.getAccountInfo(pool); const data = new Uint8Array(info.data); const base = 8; const currentRootOffset = base + 32 * 8; const currentRoot = data.slice(currentRootOffset, currentRootOffset + 32); console.log('poolRoot', bytesLEToCanonicalHex(currentRoot)); })();"

   # Commitment tree
   npx tsx -e "import { Connection, PublicKey } from '@solana/web3.js'; import { decodeCommitmentTree, commitmentToHex } from './web/app/lib/onchain/commitmentTree'; (async () => { const conn = new Connection('http://127.0.0.1:8899','confirmed'); const tree = new PublicKey('<commitmentTreePda>'); const info = await conn.getAccountInfo(tree); const state = decodeCommitmentTree(new Uint8Array(info.data)); console.log('treeRoot', commitmentToHex(state.currentRoot)); })();"
   ```
   Replace `<poolId>` and `<commitmentTreePda>` with values from `mints.generated.json`.

2. **Check Photon snapshot:**
   ```bash
   curl -s http://127.0.0.1:8787/roots/<originMint>
   ```

If any of these roots differ, root drift has occurred.

## Recovery Procedure

Preferred recovery:

```bash
./scripts/reset-dev-env.sh
```

The script stops the `zpump-devnet` systemd unit (or any stray validators), wipes the ledger + Photon snapshot, reruns bootstrap, restarts PM2 services, and executes the wrap/unwrap smoke test to ensure roots stay in sync.

If you cannot run the reset script, follow the manual sequence:

```bash
systemctl --user stop zpump-devnet || pkill -f solana-test-validator
rm -rf ~/.local/share/zpump-devnet-ledger
rm -f indexer/photon/data/state.json
systemctl --user start zpump-devnet || ./scripts/start-private-devnet.sh
npx tsx web/app/scripts/bootstrap-private-devnet.ts
cd web/app && npm run build && cd ..
pm2 restart ptf-indexer --update-env
pm2 restart ptf-web --update-env
```

Either approach redeploys programs, recreates pool + commitment tree PDAs, and repopulates Photon with fresh roots.

## Prevention Tips

- Avoid `Ctrl+C`-ing the validator; use the script to stop it cleanly.
- Clear the ledger and indexer snapshot before re-running bootstrap.
- Ensure the frontend publishes new roots to Photon (`indexerClient.publishRoots`)—already handled in `ConvertForm`.
- Monitor validator logs after wraps to ensure root updates succeed; use the wrap/unwrap E2E script for smoke tests.

## Production Considerations

On shared devnet/mainnet, validators provide stronger guarantees against partial writes, but:
- Always check that programs emit updated roots to the indexer.
- Consider adding automated reconciliations that compare pool and commitment tree roots regularly.
- Ensure indexer snapshots are backed by durable storage and versioned updates.

