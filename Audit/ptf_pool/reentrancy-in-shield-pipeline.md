# Reentrancy in Shield Pipeline

## Severity: HIGH

## Description

The `shield` instruction performs multiple state-changing operations across several instructions (`shield`, `shield_finalize_tree`, `shield_finalize_ledger`, `shield_check_invariant`). While Solana's transaction model provides some protection against reentrancy, there are potential race conditions and state inconsistencies that could be exploited if the multi-step pipeline is not properly synchronized.

## Vulnerability Details

The shield operation is split across multiple transactions:
1. `shield` - Deposits tokens and activates shield claim
2. `shield_finalize_tree` - Updates Merkle tree
3. `shield_finalize_ledger` - Records note in ledger
4. `shield_check_invariant` - Validates supply invariant

### Potential Exploits

1. **Stale Shield Claim Reuse**: An attacker could potentially reuse a stale shield claim if the old_root validation is bypassed or if there's a race condition between checking claim validity and finalizing.

2. **Pending Shield State Manipulation**: The `pending_shield` state in `PoolState` could be manipulated if multiple shield operations are attempted simultaneously, potentially allowing double-spending or inconsistent state.

3. **Tree Root Desynchronization**: If `shield_finalize_tree` fails but `shield` succeeds, the vault has received tokens but the commitment tree hasn't been updated, creating an inconsistent state.

## Exploitation Scenario

```rust
// Scenario 1: Stale claim reuse
// 1. Attacker initiates shield with old_root = R1
// 2. Before shield_finalize_tree executes, another transaction updates root to R2
// 3. Attacker's shield claim becomes stale (old_root R1 != current_root R2)
// 4. If the stale claim check is bypassed, attacker could finalize with wrong root

// Scenario 2: Race condition in pending_shield
// 1. Transaction A: shield() sets pending_shield.active = 1
// 2. Transaction B: shield() also sets pending_shield.active = 1 (if check fails)
// 3. Both transactions could proceed, causing double deposits
```

## Code References

- `shield` instruction: Lines 497-922 in `programs/pool/src/lib.rs`
- Stale claim detection: Lines 686-703
- Pending shield management: Lines 658-680, 705-709

## Mitigation

1. **Atomic Transaction Requirement**: Ensure `shield_finalize_ledger` is included in the same transaction as `shield` (already implemented via `E_SHIELD_FINALIZE_MISSING` check).

2. **Stricter Stale Claim Validation**: The current implementation deactivates stale claims, which is good, but consider adding a timestamp-based expiration to prevent very old claims from being reactivated.

3. **Pending Shield Lock**: Add a more robust locking mechanism that prevents concurrent shield operations, possibly using a sequence number or nonce.

4. **State Consistency Checks**: Add explicit checks after each step to ensure the state is consistent before proceeding to the next step.

5. **Event Logging**: Emit detailed events at each step to enable off-chain monitoring and detection of anomalous patterns.

## Recommended Code Changes

```rust
// Add timestamp to ShieldClaim
pub struct ShieldClaim {
    // ... existing fields ...
    pub created_at: i64, // Add timestamp
    pub expires_at: i64, // Add expiration
}

// In shield(), add expiration check
let clock = Clock::get()?;
if shield_claim.is_active() && clock.unix_timestamp > shield_claim.expires_at {
    // Claim expired, deactivate
    shield_claim.deactivate();
    pool_state.pending_shield.deactivate();
}

// Add sequence number to prevent race conditions
pub struct PoolState {
    // ... existing fields ...
    pub shield_sequence: u64, // Increment on each shield
}
```

