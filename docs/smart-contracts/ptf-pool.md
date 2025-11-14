# `ptf_pool` Program Documentation

The `ptf_pool` Anchor program is the core of zPump. It orchestrates the shielding (wrap) and unshielding (unwrap) flows, maintains the commitment tree and note ledger, and coordinates with the vault and factory programs. This document covers architecture, PDAs, instructions, feature flags, and compute considerations.

> **Active Work:** The program currently ships in a “lightweight” build that skips heavy Merkle operations and invariant checks to stay below Solana’s 1.4 M CU limit. Re-enabling `full_tree`, `note_digests`, and `invariant_checks` is ongoing.

## Program ID & Features

- Program ID: `7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh`
- `Cargo.toml` feature flags:
  - `lightweight` *(default)*: Minimal commitment tree updates.
  - `full_tree`: Recomputes the full tree on every shield/unshield.
  - `note_digests`: Maintains Poseidon digests of commitments/nullifiers.
  - `invariant_checks`: Enforces vault/twin-mint supply conservation.
- Default build profile: `["lightweight"]`
- Production profile (goal): `["full_tree","note_digests","invariant_checks"]`

## PDAs & Accounts

| PDA | Seeds | Purpose |
|-----|-------|---------|
| Pool State | `["pool", origin_mint]` | Primary state: current root, recent roots, vault, twin mint, feature flags, fees, verifying key. |
| Commitment Tree | `["commitment-tree", origin_mint]` | Stores Merkle tree frontier, canopy, next index, current root. |
| Note Ledger | `["note-ledger", origin_mint]` | Tracks note commitments, amount commitments, poseidon digests (optional). |
| Nullifier Set | `["nullifier-set", origin_mint]` | Maintains spent note nullifiers. |
| Hook Config | `["hook", origin_mint]` | Optional post-shield hook metadata. |

Important foreign accounts:

- Vault state & token account (from `ptf_vault`).
- Mint mapping (from `ptf_factory`).
- Optional twin mint (SPL or Token-2022).
- Verifying key account for Groth16 proofs (`ptf_verifier_groth16`).

## State Structure (PoolState)

Key fields (refer to source for exhaustive list):

- `current_root: [u8;32]` – Mirrors commitment tree’s current root.
- `recent_roots: [[u8;32]; 16]` + `recent_roots_len` – Sliding window of historical roots.
- `vault: Pubkey` – Associated vault PDA.
- `origin_mint: Pubkey` – SPL mint for the public token.
- `twin_mint: Pubkey` + `twin_mint_enabled: bool` – Optional zToken mint mapping.
- `verifier_program`, `verifying_key`, `verifying_key_id`, `verifying_key_hash` – Groth16 metadata.
- `fee_bps: u16` – Protocol fee in basis points.
- `features: FeatureFlags` – Bitmask controlling hooks/invariant checks.
- `hook_config_present: bool` – Indicates optional hook account.

## Instructions

### `initialize_pool`

Initialises all PDAs for a mint:

- Seeds & bumps derived for pool, commitment tree, note ledger, nullifier set, hook config.
- Loads verifying key metadata from `ptf_verifier_groth16`.
- Sets initial `current_root` to the canonical zero root.
- Registers hook features if provided.
- Requires CPI to `ptf_vault` to allocate the vault state ahead of time.

### `shield`

Performs wrap (public → private):

1. **Account validation**
   - Verifies verifying key program & account matches pool state.
   - Asserts vault token account is owned by pool’s vault PDA and minted to the origin mint.
   - Ensures commitment tree account key matches pool state and current root equals pool’s root.
2. **Proof verification**
   - Parses Groth16 public inputs: old root, new root, commitment, amount, etc.
   - Requires `old_root == pool_state.current_root`.
   - Calls `ptf_verifier_groth16::verify_groth16`.
3. **Custody update**
   - CPI into `ptf_vault::deposit` to transfer tokens from `depositor_token_account` to vault.
4. **Commitment tree**
   - Lightweight mode: increments `next_index`, updates `current_root` with the proof’s `new_root`, records `(index, commitment, amount_commit)` in recent canopy.
   - Full-tree mode: recomputes the Merkle path with Poseidon hashes.
5. **Note ledger**
   - Appends note amount commitment and (optionally) updates digest.
6. **Hooks (optional)**
   - If the hook feature is enabled _and_ `post_shield_enabled` is true, validates remaining accounts and performs the post-shield hook CPI.

### `unshield_to_origin` / `unshield_to_ptkn`

Redeems zTokens back to public form or the private twin mint:

1. **Account validation**
   - Same verifying key checks as `shield`.
   - Ensures destination token account matches mode (origin or twin).
   - Caches pool state fields, then drops mutable borrow before CPIs to avoid double borrow (fix for earlier `AccountBorrowFailed`).
2. **Proof validation**
   - Parses public inputs: old/new roots, nullifiers, change commitments, amount, fee, destination, pool ID.
   - Uses `decode_amount_from_field` to interpret Groth16 fixed-point outputs (raw `u64` now).
3. **Root check**
   - Requires proof’s `old_root` equals pool state.
4. **Nullifier & ledger update**
   - Records nullifiers, appends change note if any.
5. **Custody action**
   - Mode `Origin`: CPI into `ptf_vault::release` to transfer public tokens to destination ATA.
   - Mode `Twin`: CPI into `ptf_factory::mint_ptkn` for privacy twin redemption.
6. **Commitment tree**
   - Lightweight mode: increments `next_index`, sets `current_root` to proof’s `new_root`.
   - Full-tree mode: recomputes tree with `append_many`.

### `set_fee`, `toggle_features`, `update_hook_config`

Administrative instructions (authority-gated). In devnet they are primarily used during bootstrap to configure fees and hook settings.

## Commitment Tree Implementation

- Depth: 32 levels (1024 leaves), canopy size configurable (default 16).
- Uses Poseidon hash (`programs/pool/src/poseidon.rs`) with precomputed zero nodes (`MERKLE_ZEROES`).
- Frontier caching avoids repeated conversions.
- Lightweight feature: `commitment_tree.append_note` is replaced with a minimal update that trusts the proof’s `new_root`.

## Note Ledger & Nullifier Set

- Maintains `recent_commitments` (leaf index, commitment, amount commitment).
- Optional digest updates if `note_digests` feature is enabled.
- Nullifier set enforces one-time spend constraints; additional digest maintained by `note_digests`.

## Compute Budget

- Wrap transactions include `ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })`. Actual usage in lightweight mode ~ 1.0–1.1 M.
- Unwrap transactions include both limit and optional price; ALTs reduce instruction account list size.
- Full feature flags currently exceed the 1.4 M cap—work in progress to profile hotspots (Merkle reconstruction, digest updates, invariant checks) and slim them down.

## Common Errors

- `E_ROOT_MISMATCH (0x1790)` – Raised when pool and commitment tree roots differ. Typically caused by validator crashes; see [Root Drift Playbook](../operations/root-drift.md).
- `E_INSUFFICIENT_LIQUIDITY (0x1779)` – Attempted unshield without enough vault funds; ensure the wrap deposited `amount + fee`.
- `ConstraintMut` / `AccountOwnedByWrongProgram` – Occur when optional accounts (twin mint) are omitted or mis-owned. Frontend SDK handles injecting placeholder program IDs for unused optional accounts.

## Testing & Tooling

- `web/app/scripts/wrap-unwrap-local.ts` – E2E script that bootstrap, wraps, unshields using local RPC.
- `programs/pool/src/tests` – Rust unit/integration tests (see TODO).
- `docs/operations/root-drift.md` – Troubleshooting steps when roots diverge.

## Interaction Tips

- Always read the commitment tree root from the tree account **and** the pool state; they should match.
- After wraps, POST the new root to Photon (`/roots/:mint`). The frontend now does this automatically.
- When toggling features or fees, rebuild the frontend to pick up new configuration.

## References

- [Source: `programs/pool/src/lib.rs`](../../programs/pool/src/lib.rs)
- [Poseidon implementation](../../programs/pool/src/poseidon.rs)
- [Anchor IDL: `web/app/idl/ptf_pool.json`](../../web/app/idl/ptf_pool.json)

