# `ptf_pool` Program Documentation

The `ptf_pool` Anchor program is the core of zPump. It orchestrates the shielding (wrap) and unshielding (unwrap) flows, maintains the commitment tree and note ledger, and coordinates with the vault and factory programs. This document covers architecture, PDAs, instructions, feature flags, and compute considerations.

## Program ID & Features

- Program ID: `7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh`
- `Cargo.toml` feature flags:
  - `lightweight`: Legacy mode that trusts proof-supplied roots (only used for benchmarking).
  - `full_tree`: Recomputes the Merkle tree on-chain.
  - `note_digests`: Maintains digests of commitments/nullifiers (now backed by SHA-256).
  - `invariant_checks`: Enforces vault/twin-mint supply conservation.
- Default build profile: `["full_tree","note_digests","invariant_checks"]`

## PDAs & Accounts

| PDA | Seeds | Purpose |
|-----|-------|---------|
| Pool State | `["pool", origin_mint]` | Primary state: current root, recent roots, vault, twin mint, feature flags, fees, verifying key. |
| Commitment Tree | `["commitment-tree", origin_mint]` | Stores Merkle tree frontier, canopy, next index, current root. |
| Note Ledger | `["note-ledger", origin_mint]` | Tracks note commitments, amount commitments, poseidon digests (optional). |
| Nullifier Set | `["nullifier-set", origin_mint]` | Maintains spent note nullifiers. |
| Shield Claim | `["claim", pool_state]` | Tracks the multi-step wrap finalisation pipeline. |
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

### `shield` + finalisation pipeline

Performs wrap (public → private). The work is split across several instructions so each stays well below 200 k CU:

1. **`shield`**
   - Validates accounts, verifying key, vault ownership, and the `ShieldClaim` PDA (initialised lazily via `init_if_needed`).
   - Parses Groth16 inputs (old root, new root, note commitment bytes, amount, recipient, etc.) and ensures `old_root == pool_state.current_root`.
   - Calls `ptf_verifier_groth16::verify_groth16`.
   - CPIs into `ptf_vault::deposit` to transfer tokens from the depositor ATA.
   - Activates the `ShieldClaim` PDA with the pending commitment data; no heavy state mutation happens yet.
2. **`shield_finalize_tree`**
   - Appends the note to the on-chain Merkle tree using SHA-256 leaves/branches (the Poseidon commitment bytes exported by the circuit are re-hashed via `hashv`).
   - Updates the pool’s `current_root`, canopy, and pending shield metadata.
3. **`shield_finalize_ledger`**
   - Records the note in the ledger, updates optional digests, and, if hooks are enabled, performs the post-shield CPI.
   - Marks whether the supply invariant needs to be enforced in a follow-up instruction.
4. **`shield_check_invariant`**
   - Enforces the vault/twin mint invariant only when flagged by the ledger step.
   - Clears the `ShieldClaim`.

The frontend SDK monitors the claim PDA between each step to ensure it has progressed before submitting the next transaction.

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
   - Full mode recomputes the SHA tree via `append_many`, emitting a log if the proof-supplied root differs from the computed one (for diagnostics). Lightweight mode, if compiled, still trusts the proof root.

### `set_fee`, `toggle_features`, `update_hook_config`

Administrative instructions (authority-gated). In devnet they are primarily used during bootstrap to configure fees and hook settings.

## Commitment Tree Implementation

- Depth: 32 levels (1024 leaves), canopy size configurable (default 16).
- Leaves and branches are hashed with Solana’s SHA-256 syscall (`hashv`). Poseidon commitments remain inside the circuits; the circuits also expose canonical byte arrays so on-chain hashing is deterministic.
- Precomputed SHA zero nodes replace the old Poseidon constants.
- Frontier caching avoids repeated allocations.
- Lightweight feature: `commitment_tree.append_note` still short-circuits for profiling, but it is no longer the default path.

## Note Ledger & Nullifier Set

- Maintains `recent_commitments` (leaf index, commitment, amount commitment).
- Optional digest updates if `note_digests` feature is enabled.
- Nullifier set enforces one-time spend constraints; additional digest maintained by `note_digests`.

## Compute Budget

- Wrap transactions include `ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })`, and the SDK sends **four** transactions (shield + three follow-ups). Combined CU is ~150 k per shield pipeline.
- Unwrap transactions leverage ALTs and consume ~146 k CU with all features enabled.
- The `lightweight` feature remains available for regression testing but is no longer required to stay under the budget.

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

