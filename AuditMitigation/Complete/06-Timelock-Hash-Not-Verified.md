# Fix 06: Timelock Execution Doesn't Verify Action Hash (HIGH)

## Problem Description

### Location
- **Contract**: `ptf_factory`
- **File**: `programs/factory/src/lib.rs`
- **Lines**: 243-322

### Current Behavior
When executing a timelock action, the `execute_timelock_action` function matches on the action type and executes it, but it doesn't re-verify that the action hash stored in the timelock entry matches the actual action. This means if the action was tampered with after queuing, the wrong action could be executed.

### Code Snippet (Current - Broken)

```rust
pub fn execute_timelock_action(ctx: Context<ExecuteTimelockAction>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    let entry = &mut ctx.accounts.timelock_entry;
    require!(!entry.executed, FactoryError::TimelockConsumed);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= entry.execute_after,
        FactoryError::TimelockNotReady
    );

    // ⚠️ PROBLEM: No hash verification before execution!
    match &entry.action {
        TimelockAction::SetDefaultFeatures { features } => {
            state.default_features = FeatureFlags::from(*features);
            // ... executes without verifying hash matches
        }
        // ... other actions ...
    }
    
    entry.executed = true;
    Ok(())
}
```

### Why This Is High Severity

1. **Action Tampering Risk**: If the action field in the timelock entry is tampered with after queuing (e.g., through account data manipulation), the wrong action will execute even though the hash doesn't match.

2. **Hash Mismatch Undetected**: The hash is computed during `queue_timelock_action` and stored, but never verified during execution. This breaks the integrity guarantee.

3. **Wrong Action Execution**: An attacker who can manipulate account data could:
   - Queue a safe action (e.g., pause factory)
   - Tamper with the action to be malicious (e.g., set fees to 100%)
   - Execute the malicious action
   - The hash won't match, but execution proceeds anyway

4. **Integrity Violation**: The hash is meant to ensure the action hasn't been tampered with. Not verifying it defeats this purpose.

### Attack Scenario

1. Attacker queues a timelock action: `SetDefaultFeatures { features: 0x01 }`
2. Hash is computed and stored: `hash = hashv([factory, action_bytes, execute_after])`
3. Attacker (or malicious actor) manipulates the account data to change action to: `SetDefaultFeatures { features: 0xFF }`
4. Timelock expires
5. `execute_timelock_action` is called
6. Code executes the tampered action (features: 0xFF) without verifying hash
7. Wrong action executes, potentially compromising protocol

## Solution

### Fix Strategy
Recompute the action hash during execution and verify it matches the stored hash. If they don't match, reject the execution.

### Implementation

#### Step 1: Add Hash Verification in `execute_timelock_action`

**Location**: `programs/factory/src/lib.rs` around line 243

**Change**:
```rust
pub fn execute_timelock_action(ctx: Context<ExecuteTimelockAction>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    let entry = &mut ctx.accounts.timelock_entry;
    require!(!entry.executed, FactoryError::TimelockConsumed);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= entry.execute_after,
        FactoryError::TimelockNotReady
    );

    // CRITICAL FIX: Recompute and verify action hash
    let action_bytes = entry.action
        .try_to_vec()
        .map_err(|_| error!(FactoryError::SerializationError))?;
    let expected_hash = hashv(&[
        state.key().as_ref(),
        &action_bytes,
        &entry.execute_after.to_le_bytes(),
    ]);
    
    require!(
        expected_hash == entry.action_hash,
        FactoryError::TimelockHashMismatch
    );

    // Now safe to execute the action
    match &entry.action {
        TimelockAction::SetDefaultFeatures { features } => {
            state.default_features = FeatureFlags::from(*features);
            state.last_updated_slot = clock.slot;
            emit!(DefaultFeaturesUpdated {
                authority: state.authority,
                features: *features,
            });
        }
        TimelockAction::UpdateMint {
            origin_mint,
            params,
        } => {
            let mapping = ctx
                .accounts
                .mint_mapping
                .as_mut()
                .ok_or(FactoryError::TimelockMissingMapping)?;
            require_keys_eq!(
                mapping.origin_mint,
                *origin_mint,
                FactoryError::OriginMintMismatch
            );
            apply_mint_update(
                state,
                mapping,
                params,
                ctx.accounts.ptkn_mint.as_ref(),
                ctx.accounts.token_program.as_ref(),
                Some(&ctx.accounts.rent),
                Some(&ctx.accounts.executor),
                None,
            )?;
            emit!(MintUpdated {
                origin_mint: mapping.origin_mint,
                ptkn_mint: mapping.ptkn_mint,
                features: mapping.features.bits(),
                fee_bps_override: if mapping.has_fee_override {
                    Some(mapping.fee_bps_override)
                } else {
                    None
                },
            });
        }
        TimelockAction::PauseFactory => {
            state.paused = true;
            emit!(FactoryPaused {
                authority: state.authority,
            });
        }
        TimelockAction::UnpauseFactory => {
            state.paused = false;
            emit!(FactoryUnpaused {
                authority: state.authority,
            });
        }
    }

    state.last_updated_slot = clock.slot;
    entry.executed = true;

    emit!(TimelockExecuted {
        factory: state.key(),
        action_hash: entry.action_hash,
        executed_at: clock.unix_timestamp,
        executor: ctx.accounts.executor.key(),
    });
    Ok(())
}
```

#### Step 2: Add Error Type

**Location**: `programs/factory/src/lib.rs` in error enum

**Add**:
```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("E_TIMELOCK_HASH_MISMATCH")]
    TimelockHashMismatch,
    // ... other errors ...
}
```

#### Step 3: Verify Hash Computation Matches Queue Logic

**Location**: `programs/factory/src/lib.rs` in `queue_timelock_action`

**Verify** the hash computation matches (it should already be correct):
```rust
let action_bytes = action
    .try_to_vec()
    .map_err(|_| error!(FactoryError::SerializationError))?;
let expected_hash = hashv(&[
    state.key().as_ref(),
    &action_bytes,
    &execute_after.to_le_bytes(),
]);
```

This should match exactly what we compute in `execute_timelock_action`.

### Testing

#### Test Case 1: Valid Hash Executes
```rust
#[test]
fn test_valid_hash_executes() {
    // Queue action with valid hash
    // Execute after timelock
    // Expected: Action executes successfully
}
```

#### Test Case 2: Tampered Action Rejected
```rust
#[test]
fn test_tampered_action_rejected() {
    // Queue action
    // Manually tamper with action in account data
    // Try to execute
    // Expected: Fails with TimelockHashMismatch
}
```

#### Test Case 3: Hash Computation Consistency
```rust
#[test]
fn test_hash_computation_consistency() {
    // Queue action, get hash
    // Recompute hash from action
    // Expected: Hashes match
}
```

### Verification Checklist

- [ ] Hash verification added to `execute_timelock_action`
- [ ] Hash computation matches `queue_timelock_action` logic
- [ ] `TimelockHashMismatch` error type added
- [ ] All tests pass
- [ ] Code review completed
- [ ] Integration tests verify fix

### Additional Considerations

1. **Hash Algorithm**: Ensure `hashv` is the same function used in both places

2. **Serialization**: Ensure `try_to_vec()` produces the same bytes in both queue and execute

3. **Edge Cases**: Test with:
   - Different action types
   - Empty actions (if possible)
   - Maximum size actions

4. **Performance**: Hash computation adds minimal overhead but is critical for security

### Impact Assessment

**Before Fix**: 
- Security: HIGH vulnerability
- Risk: Wrong actions could execute if tampered

**After Fix**:
- Security: Hash verification ensures integrity
- Risk: None (as designed)
- Breaking Change: No (adds validation, doesn't change behavior for valid actions)

### Rollout Plan

1. Implement hash verification
2. Add comprehensive tests
3. Deploy to testnet
4. Verify all existing timelock entries still work
5. Deploy to mainnet
6. Monitor for any hash mismatches (should never happen for valid actions)

---

**Priority**: HIGH - Fix before production
**Estimated Effort**: Low (simple hash check)
**Risk of Fix**: Low (adds security, no breaking changes)

