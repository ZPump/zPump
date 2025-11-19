# Mitigation: Action Hash Validation Missing Salt in Execute

## Severity: CRITICAL
## Contract: ptf_factory
## Issue ID: 1

## Problem Description

The action hash recomputed during execution does NOT include the salt, but the hash stored during queuing DOES include salt:

- **Queue (line 243):** `hash(factory || salt || action || execute_after)`
- **Execute (lines 401-405):** `hash(factory || action || execute_after)` ❌ MISSING SALT

This mismatch will cause ALL execution attempts to fail, permanently locking all timelock actions.

## Security Impact

1. **All timelock actions become unexecutable** - Cannot execute any queued timelock action
2. **Permanent DoS** - Factory operations requiring timelock are blocked
3. **Emergency upgrade required** - Cannot fix without redeploying

## Mitigation

Add salt to hash recomputation in `execute_timelock_action()`:

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

    // CRITICAL FIX: Include salt in hash recomputation to match queue hash
    let action_bytes = entry.action
        .try_to_vec()
        .map_err(|_| error!(FactoryError::SerializationError))?;
    let expected_hash = hashv(&[
        state.key().as_ref(),
        &entry.salt, // ADD THIS LINE - matches queue hash
        &action_bytes,
        &entry.execute_after.to_le_bytes(),
    ]);
    
    require!(
        expected_hash.to_bytes() == entry.action_hash,
        FactoryError::TimelockHashMismatch
    );

    // ... rest of function
}
```

## Testing

1. Queue a timelock action with known salt
2. Wait for timelock period
3. Execute the action - should succeed with fix, fail without fix
4. Verify hash matches between queue and execute

## References

- Issue location: `programs/factory/src/lib.rs:396-410`
- Queue hash location: `programs/factory/src/lib.rs:243-248`

