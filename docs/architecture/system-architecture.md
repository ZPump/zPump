# System Architecture

zPump comprises several cooperating subsystems deployed across the Solana runtime, off-chain services, and the Next.js frontend. This document outlines the architecture, key PDAs, and the data/compute flow for the most common operations.

## Component Diagram (Conceptual)

```
Browser (Next.js App)
 ├─ Wallet Adapter (Simulation wallet, Phantom, etc.)
 ├─ SDK (`web/app/lib/sdk.ts`)
 │   ├─ Wrap / Unwrap transaction builders
 │   ├─ Indexer client (`/api/indexer`)
 │   └─ Proof client (`/api/proof`)
 ├─ Convert UI
 └─ Faucet UI

Next.js API Routes
 ├─ `/api/proof/...`       (Proxy to Proof RPC)
 ├─ `/api/indexer/...`    (Proxy to Photon)
 ├─ `/api/faucet/...`     (Local faucet logic)
 └─ Static assets / pages

Off-chain Services
 ├─ Proof RPC (`services/proof-rpc`)
 │   ├─ Derives Groth16 public inputs
 │   └─ Calls snarkjs to generate proofs
 └─ Photon Indexer (`indexer/photon`)
     ├─ Mirrors roots, nullifiers, notes, balances
     ├─ Supports incremental note queries (afterSlot/viewTag)
     └─ Persists snapshot to disk

On-chain Programs (Anchor)
 ├─ `ptf_pool`        – shielding/unshielding, commitment tree, note ledger
 ├─ `ptf_vault`       – SPL token custody
 ├─ `ptf_factory`     – mint ↔ pool mapping, twin mint metadata
 └─ `ptf_verifier_groth16` – Groth16 proof verification syscall wrapper

Solana Accounts
 ├─ Pool State PDA:      `["pool", origin_mint]`
 ├─ Commitment Tree PDA: `["commitment-tree", origin_mint]`
 ├─ Note Ledger PDA:     `["note-ledger", origin_mint]`
 ├─ Nullifier Set PDA:   `["nullifier-set", origin_mint]`
 ├─ Vault State PDA:     `["vault", origin_mint]`
 └─ Twin Mint (optional): minted by factory if privacy twin is enabled
```

## Request Flow: Shield (Wrap)

1. **UI / SDK**
   - Fetch latest commitment tree root from the indexer (fallback to chain).
   - Build proof payload: old root, amount, recipient, deposit identifier, blinding.
   - Request proof from Proof RPC (Groth16), receive base64 proof + canonical public inputs.
   - Build transaction: compute budget instruction, optional ATA create, call `ptf_pool::shield`.

2. **Proof RPC**
   - Validates inputs, converts to little-endian bytes, derives note commitment, amount commitment.
   - Produces Groth16 proof (`proof`, `publicInputs`) using snarkjs and cached verification keys.

3. **On-chain (`ptf_pool::shield`)**
   - Loads pool state, commitment tree; ensures the stored `pool_state.current_root` equals the tree’s `current_root` (this is where drift manifests if the validator crashed).
   - Verifies the Groth16 proof via `ptf_verifier_groth16`.
   - CPI into `ptf_vault::deposit` to pull public tokens into custody.
   - In lightweight mode:
     - Increment commitment tree `next_index`, set `current_root` to the proof’s `new_root`, record recent root list.
     - Append note record to the in-memory note ledger.
   - Push new root into the pool’s recent queue.

4. **Post-transaction**
   - Indexer picks up new root/nullifiers (either via client POST or on next sync).
   - Frontend refreshes balances from Photon (`/balances/:wallet`) and the commitment tree root.

## Request Flow: Unshield (Unwrap)

1. **UI / SDK**
   - Select a note (zToken) from indexer snapshot.
   - Fetch latest root + nullifiers, ensure note is unspent.
   - Build proof payload with note ID, spending key, destination, fee.
   - Request proof from Proof RPC (Groth16).
   - Build transaction: compute budget instructions, optional ATA create, call `ptf_pool::unshield_to_origin` (or `_to_ptkn` if redeeming to the twin mint).
   - Leverage Address Lookup Table (ALT) to fit within the 1232-byte transaction size limit.

2. **Proof RPC**
   - Canonicalises inputs, derives change outputs if any, returns proof + canonical public inputs.

3. **On-chain (`ptf_pool::unshield_*`)**
   - Validates proof fields against pool state, destination, pool ID, fee.
   - Perform CPI to `ptf_vault::release` (origin) or `ptf_factory::mint_ptkn` (twin).
   - Update note ledger/nullifier set.
   - Lightweight mode skips the full Merkle tree rebuild; only `current_root` and `next_index` are updated.

4. **Indexer**
   - Client posts nullifier(s) to the indexer; Photon removes notes, adjusts balances, updates snapshots.

## Data Sources

| Data | Source | Notes |
|------|--------|-------|
| Commitment roots | Photon (`/roots/:mint`) with chain fallback | Clients push updated roots to photon after wraps to keep snapshots fresh. |
| Nullifiers | Photon (`/nullifiers/:mint`) | Guard against double-spends. |
| Notes | Photon (`/notes/mint/:mint?afterSlot=…&viewTag=…`) | Supports incremental sync for wallets. |
| Balances | Photon (`/balances/:wallet`) | Optional; primarily for shielded balance display. |
| Proofs | Proof RPC (`/prove/shield` & `/prove/unshield`) | Accepts canonical hex, emits little-endian bytes for on-chain verification. |

## Feature Flags & Compute Profiles

`ptf_pool` consumes significant compute. To stay below Solana’s 1.4 M CU transaction limit, the repo currently compiles the program with the `lightweight` feature (default), which:

- Skips full commitment tree recomputation (`full_tree` disabled).
- Skips note digest maintenance (`note_digests` disabled).
- Skips invariant checks on vault/twin mint supply (`invariant_checks` disabled).

Full security features are still available (`anchor build -- --features full_tree,note_digests,invariant_checks`), but they presently exceed the CU budget. We are actively refactoring to re-enable them while staying within the limit. The documentation calls out feature-dependent sections throughout.

## PDAs & Seeds

| PDA | Seeds | Program |
|-----|-------|---------|
| Pool State | `["pool", origin_mint]` | `ptf_pool` |
| Commitment Tree | `["commitment-tree", origin_mint]` | `ptf_pool` |
| Note Ledger | `["note-ledger", origin_mint]` | `ptf_pool` |
| Nullifier Set | `["nullifier-set", origin_mint]` | `ptf_pool` |
| Vault State | `["vault", origin_mint]` | `ptf_vault` |
| Mint Mapping | `["mint-mapping", origin_mint]` | `ptf_factory` |
| Hook Config | `["hook", origin_mint]` | `ptf_pool` |

(See individual smart contract docs for more PDAs, including verifying keys and address lookup tables.)

## Execution Environments

- **Private Devnet** – Single-node `solana-test-validator` with preloaded programs. Scripts kill stale processes, wipe `~/.local/share/zpump-devnet-ledger`, and restart cleanly to avoid root drift.
- **Public Clusters** – Not yet officially supported, but the programs use fixed IDs from `Anchor.toml`, so deployment to devnet/testnet follows standard Anchor workflows. Proof RPC must be reachable, and Photon should point to an RPC node with WebSocket support.

## Persistent Storage

- **Photon snapshot** – Default at `indexer/photon/data/state.json`. Stores roots, nullifiers, notes, balances. Clear it (`rm`) when resetting the ledger to avoid desynchronisation.
- **Proof keys** – `web/app/scripts/bootstrap-private-devnet.ts` expects Groth16 verifying keys under `circuits/keys`. The proof RPC loads them from its own config.
- **Mint catalogue** – Generated file `web/app/config/mints.generated.json` records origin mints, pool IDs, twin mints, and ALT addresses. Rebuild the frontend (`npm run build`) after regeneration so the UI references the correct accounts.

## Next Steps

With the architecture in mind, explore:

- [Smart contract internals](../smart-contracts/ptf-pool.md) for instruction-by-instruction breakdown.
- [Developer workflow](../development/private-devnet.md) for the exact bootstrap sequence.
- [Compute strategy](../operations/compute-budget.md) to understand ongoing optimisation work aimed at re-enabling full security features within the CU limit.

