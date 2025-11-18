# Mitigation: Pending Action Hashes Vector DoS

## Severity: CRITICAL
## Contract: ptf_factory
## Issue ID: 9

## Problem Description

Pending action hashes vector can be filled up (MAX_PENDING_ACTIONS = 50) and if actions are never executed/canceled, no new actions can be queued.

## Security Impact

1. **DoS Attack:** Attacker queues 50 actions and never executes them
2. **Permanent Block:** No new timelock actions possible
3. **System Freeze:** Critical operations blocked

## Mitigation

Add automatic cleanup of stale actions:

```rust
pub fn cleanup_stale_actions(ctx: Context<CleanupActions>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    let clock = Clock::get()?;
    let stale_threshold = clock.unix_timestamp - (30 * 24 * 60 * 60); // 30 days
    
    // Remove actions older than threshold
    let mut to_remove = Vec::new();
    for (idx, entry) in state.timelock_entries.iter().enumerate() {
        if entry.queued_at < stale_threshold && !entry.executed && !entry.canceled {
            to_remove.push(idx);
        }
    }
    
    // Remove in reverse order to maintain indices
    for &idx in to_remove.iter().rev() {
        state.pending_action_hashes.remove(idx);
    }
    
    Ok(())
}
```

## Alternative

Increase MAX_PENDING_ACTIONS or use more efficient data structure (hash set).

## References

- Issue location: `programs/factory/src/lib.rs:256-258, 293`

