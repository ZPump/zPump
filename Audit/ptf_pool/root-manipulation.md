# Root Manipulation and Validation

## Severity: CRITICAL

## Description

The Merkle tree root is critical for maintaining the integrity of the shielded pool. Any manipulation of the root could allow attackers to create fake commitments, double-spend, or withdraw funds they don't own. While the code has several root validation checks, there are edge cases and potential vulnerabilities.

## Vulnerability Details

### Root Validation Points

1. **Shield Operation**: Validates `old_root == pool_state.current_root` (line 841-844)
2. **Unshield Operation**: Validates proof's `old_root` matches pool state
3. **Private Transfer**: Validates `old_root` is known and matches commitment tree

### Potential Vulnerabilities

1. **Root Drift**: If the commitment tree root and pool state root become desynchronized (e.g., due to validator crashes), operations could fail or allow inconsistent states.

2. **Recent Roots Window**: The `recent_roots` array has a fixed size (16 entries). If more than 16 root updates occur, old roots are lost, potentially allowing replay attacks with very old roots.

3. **Root Replay**: While nullifiers prevent double-spending, if an old root is still in the `recent_roots` window, an attacker could potentially replay a transaction with that old root.

4. **Tree Root vs Proof Root Mismatch**: In `unshield`, the code logs a warning if proof-supplied root differs from computed root but still proceeds in lightweight mode.

## Exploitation Scenario

```rust
// Scenario 1: Root drift exploitation
// 1. Validator crashes after shield_finalize_tree but before pool_state update
// 2. Commitment tree has new root R2, but pool_state still has R1
// 3. Attacker could use R1 in a proof to unshield, bypassing the new commitments

// Scenario 2: Recent roots overflow
// 1. More than 16 transactions occur, pushing old valid roots out of recent_roots
// 2. Attacker finds an old valid root that's no longer in recent_roots
// 3. Attacker creates a proof with that old root and nullifiers that were never used
// 4. Since the root is "unknown" but was valid, the check might fail or behave unexpectedly
```

## Code References

- Root validation in shield: Lines 804-808, 841-844
- Root validation in unshield: Lines 1354-1364
- Recent roots management: `PoolState::push_root()` and `is_known_root()`
- Root drift handling: Documentation mentions this in `docs/operations/root-drift.md`

## Mitigation

1. **Stricter Root Validation**: Always require exact match between commitment tree root and pool state root. If they differ, halt operations and require manual intervention.

2. **Expand Recent Roots Window**: Consider increasing from 16 to 32 or 64 entries, or implement a more sophisticated root tracking mechanism.

3. **Root Timestamps**: Add timestamps to root entries to enable expiration of very old roots and prevent replay attacks.

4. **Atomic Root Updates**: Ensure root updates in both commitment tree and pool state are atomic. Consider using a single source of truth.

5. **Root Drift Detection**: Implement automatic detection and alerting for root drift scenarios.

6. **Reject Lightweight Mode in Production**: The lightweight mode that trusts proof-supplied roots should never be used in production. Ensure production builds always use `full_tree` feature.

## Recommended Code Changes

```rust
// Add timestamp to root entries
pub struct RootEntry {
    pub root: [u8; 32],
    pub timestamp: i64,
}

// Expand recent_roots and add expiration
pub struct PoolState {
    pub recent_roots: Vec<RootEntry>, // Dynamic instead of fixed array
    pub root_expiration_seconds: i64, // Configurable expiration
}

// Stricter root validation
fn validate_root_strict(
    pool_state: &PoolState,
    commitment_tree: &CommitmentTree,
    proof_root: [u8; 32],
) -> Result<()> {
    // Must match current root exactly
    require_keys_eq!(
        pool_state.current_root,
        commitment_tree.current_root,
        PoolError::RootDrift
    );
    require_keys_eq!(
        proof_root,
        pool_state.current_root,
        PoolError::RootMismatch
    );
    Ok(())
}
```

