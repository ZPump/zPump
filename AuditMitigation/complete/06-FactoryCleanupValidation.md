# Mitigation: Timelock Entry Can Be Cleaned Up While Still Valid

## Severity: HIGH
## Contract: ptf_factory
## Issue ID: 6

## Problem Description

The cleanup function only checks if 30 days have passed since `execute_after`, but doesn't properly verify the entry hasn't been executed or canceled. While `require!(!entry.executed)` exists, the cleanup sets `entry.executed = true` and `entry.canceled = true` even if the entry was never executed but is still within valid execution window.

## Security Impact

1. **Valid actions could be prematurely cleaned up** - Actions still within execution window
2. **Loss of execution ability** - Cannot execute legitimate timelock actions
3. **State inconsistency** - Entry marked executed/canceled when it shouldn't be

## Mitigation

Add proper validation that entry is truly stale:

```rust
pub fn cleanup_timelock_action(ctx: Context<CleanupTimelockAction>) -> Result<()> {
    let entry = &mut ctx.accounts.timelock_entry;
    
    // CRITICAL FIX: Verify entry hasn't been executed or canceled
    require!(!entry.executed, FactoryError::TimelockConsumed);
    require!(!entry.canceled, FactoryError::ChangeCanceled);

    let clock = Clock::get()?;
    
    // CRITICAL FIX: Only allow cleanup of entries that are:
    // 1. Past execute_after + grace period (30 days)
    // 2. Not executed
    // 3. Not canceled
    // This ensures valid actions aren't prematurely cleaned up
    let cleanup_threshold = entry.execute_after
        .checked_add(TIMELOCK_STALE_GRACE_SECONDS)
        .ok_or(FactoryError::TimelockOverflow)?;
    
    require!(
        clock.unix_timestamp >= cleanup_threshold,
        FactoryError::TimelockNotExpired
    );

    // Now safe to mark as executed and canceled for cleanup
    entry.executed = true;
    entry.canceled = true;

    let state = &mut ctx.accounts.factory_state;
    state.pending_action_hashes.retain(|&h| h != entry.action_hash);

    emit!(TimelockGarbageCollected {
        factory: state.key(),
        action_hash: entry.action_hash,
        cleaner: ctx.accounts.cleaner.key(),
        cleaned_at: clock.unix_timestamp,
    });
    
    Ok(())
}
```

## Additional Safeguard

Consider adding a check that entry is actually stale (not just past execute_after but also not recently actionable):

```rust
// Only cleanup if entry is both:
// - Past execute_after + grace period
// - And past a reasonable "forgot to execute" threshold
let forgotten_threshold = entry.queued_at
    .checked_add(TIMELOCK_STALE_GRACE_SECONDS * 2) // 60 days from queue
    .ok_or(FactoryError::TimelockOverflow)?;
    
require!(
    clock.unix_timestamp >= cleanup_threshold && 
    clock.unix_timestamp >= forgotten_threshold,
    FactoryError::TimelockNotExpired
);
```

## References

- Issue location: `programs/factory/src/lib.rs:509-536`
- TIMELOCK_STALE_GRACE_SECONDS: `programs/factory/src/lib.rs:20`

