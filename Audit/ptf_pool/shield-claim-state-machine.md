# Shield Claim State Machine Vulnerabilities

## Severity: HIGH

## Description

The shield operation uses a state machine (`ShieldClaim`) to coordinate multi-step finalization. If the state machine can be manipulated or has edge cases, shield operations could fail, be bypassed, or allow double-spending.

## Vulnerability Details

### Current Implementation

Shield claim states include:
- `STATUS_INACTIVE`: Not active
- `STATUS_PENDING_TREE`: Waiting for tree finalization
- `STATUS_AWAITING_LEDGER`: Waiting for ledger finalization
- `STATUS_AWAITING_INVARIANT`: Waiting for invariant check
- `STATUS_LEDGER_COMPLETE`: Ledger complete

State transitions are managed in:
- `shield`: Activates claim
- `shield_finalize_tree`: Marks tree complete
- `shield_finalize_ledger`: Marks ledger complete
- `shield_check_invariant`: Marks invariant complete and deactivates

### Potential Vulnerabilities

1. **State Transition Bypass**: If state transitions can be bypassed, operations could proceed out of order.

2. **Concurrent State Modifications**: If multiple transactions modify the same claim simultaneously, state could become inconsistent.

3. **Stale Claim Reuse**: If stale claims aren't properly cleaned up, they could be reused or cause confusion.

4. **State Machine Edge Cases**: Complex state transition logic (lines 1728-1760) has many edge cases that could be exploited.

5. **Status Validation**: Status validation might not catch all invalid states.

6. **Race Conditions**: Race conditions between state checks and modifications could allow invalid operations.

7. **State Corruption**: If claim state becomes corrupted, operations might fail or behave unexpectedly.

## Exploitation Scenario

```rust
// Scenario 1: State transition bypass
// 1. Attacker finds way to skip state transitions
// 2. Attacker finalizes tree without proper state
// 3. Operations proceed incorrectly
// 4. Security checks are bypassed

// Scenario 2: Concurrent modifications
// 1. Transaction A: shield() activates claim
// 2. Transaction B: shield_finalize_tree() modifies claim
// 3. Both transactions execute in same slot
// 4. State becomes inconsistent
// 5. Operations fail or behave incorrectly

// Scenario 3: Stale claim reuse
// 1. Old shield claim exists but is stale
// 2. Attacker reuses stale claim
// 3. Operations proceed with wrong state
// 4. Security checks might be bypassed

// Scenario 4: State machine edge case
// 1. Attacker triggers edge case in state transition logic
// 2. Claim enters invalid state
// 3. Operations fail or bypass checks
// 4. Security is compromised
```

## Code References

- Shield claim activation: `shield` instruction (lines 890-901)
- Tree finalization: `process_shield_finalize_tree` (lines 1723-1839)
- Ledger finalization: `process_shield_finalize_ledger` (lines 3652-3765)
- Invariant check: `shield_check_invariant` (lines 948-986)
- State transition logic: Lines 1728-1760, 3673-3680

## Mitigation

1. **Strict State Validation**: Validate state before every transition and reject invalid states.

2. **Atomic State Updates**: Ensure state updates are atomic and cannot be partially applied.

3. **State Machine Locking**: Implement locking to prevent concurrent modifications.

4. **State Transition Logging**: Log all state transitions for audit and debugging.

5. **Stale Claim Cleanup**: Implement automatic cleanup of stale claims.

6. **State Machine Simplification**: Simplify state machine to reduce edge cases.

7. **Comprehensive State Tests**: Add extensive tests for all state transitions and edge cases.

8. **State Recovery**: Implement recovery mechanisms for corrupted states.

## Recommended Code Changes

```rust
// Enhanced state validation
impl ShieldClaim {
    pub fn validate_state_transition(
        &self,
        from: u8,
        to: u8,
    ) -> Result<()> {
        // Define valid transitions
        let valid_transitions: &[(u8, u8)] = &[
            (STATUS_INACTIVE, STATUS_PENDING_TREE),
            (STATUS_PENDING_TREE, STATUS_AWAITING_LEDGER),
            (STATUS_PENDING_TREE, STATUS_LEDGER_COMPLETE),
            (STATUS_AWAITING_LEDGER, STATUS_AWAITING_INVARIANT),
            (STATUS_AWAITING_INVARIANT, STATUS_INACTIVE),
            (STATUS_LEDGER_COMPLETE, STATUS_INACTIVE),
        ];
        
        // Check if transition is valid
        let is_valid = valid_transitions.iter().any(|(f, t)| *f == from && *t == to);
        require!(
            is_valid,
            PoolError::InvalidStateTransition
        );
        
        Ok(())
    }
    
    // State machine with locking
    pub fn transition_to(
        &mut self,
        new_status: u8,
    ) -> Result<()> {
        let old_status = self.status;
        
        // Validate transition
        self.validate_state_transition(old_status, new_status)?;
        
        // Update state atomically
        self.status = new_status;
        
        // Log transition
        emit!(ShieldClaimStateTransition {
            claim: self.key(),
            old_status,
            new_status,
        });
        
        Ok(())
    }
}

// Stale claim cleanup
pub fn cleanup_stale_claims(
    ctx: Context<CleanupStaleClaims>,
) -> Result<()> {
    let clock = Clock::get()?;
    let claim = &mut ctx.accounts.shield_claim;
    
    // Check if claim is stale (older than threshold)
    const STALE_THRESHOLD_SECONDS: i64 = 24 * 60 * 60; // 24 hours
    if claim.is_active() {
        let age = clock.unix_timestamp - claim.created_at;
        if age > STALE_THRESHOLD_SECONDS {
            // Deactivate stale claim
            claim.deactivate();
            emit!(StaleClaimCleaned {
                claim: claim.key(),
                age_seconds: age,
            });
        }
    }
    
    Ok(())
}

// State recovery
pub fn recover_shield_claim_state(
    ctx: Context<RecoverClaimState>,
) -> Result<()> {
    // Only authority can recover
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.pool_state.load()?.authority,
        PoolError::Unauthorized
    );
    
    let claim = &mut ctx.accounts.shield_claim;
    
    // Check if state is invalid
    if !claim.is_valid_state() {
        // Reset to safe state
        claim.deactivate();
        emit!(ClaimStateRecovered {
            claim: claim.key(),
            recovered_by: ctx.accounts.authority.key(),
        });
    }
    
    Ok(())
}
```

