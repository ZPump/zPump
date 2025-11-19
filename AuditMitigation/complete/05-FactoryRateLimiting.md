# Mitigation: No Rate Limiting on Timelock Actions

## Severity: HIGH
## Contract: ptf_factory
## Issue ID: 5

## Problem Description

While there's a maximum pending actions check (50), there's no rate limiting on how quickly actions can be queued. An attacker could rapidly fill the queue with 50 actions and then cancel them, effectively blocking legitimate operations.

## Security Impact

1. **Temporary DoS** - Attacker fills pending action queue rapidly
2. **Legitimate operations blocked** - Cannot queue new timelock actions
3. **Requires waiting** - Must wait for timelock expiration or cleanup

## Mitigation

Add rate limiting per authority or minimum time between actions:

```rust
#[account]
pub struct FactoryState {
    // ... existing fields ...
    // CRITICAL FIX: Add rate limiting
    pub last_action_time: i64,
}

// In initialize_factory:
state.last_action_time = clock.unix_timestamp;

// In queue_timelock_action:
pub const MIN_TIME_BETWEEN_ACTIONS: i64 = 60; // 60 seconds minimum

pub fn queue_timelock_action(...) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    let clock = Clock::get()?;
    
    // CRITICAL FIX: Rate limiting - prevent rapid queue filling
    require!(
        clock.unix_timestamp >= state.last_action_time + MIN_TIME_BETWEEN_ACTIONS,
        FactoryError::ActionRateLimitExceeded
    );
    
    // ... existing checks ...
    
    state.last_action_time = clock.unix_timestamp;
    
    // ... rest of function
}
```

## Alternative: Per-Authority Rate Limiting

If multiple authorities can queue actions, use per-authority tracking:

```rust
pub const MIN_TIME_BETWEEN_ACTIONS_PER_AUTHORITY: i64 = 300; // 5 minutes per authority

// Store last_action_time per authority in separate account or hashmap
// Check against authority-specific last_action_time
```

## Recommended

Use global rate limiting (60 seconds) as it's simpler and prevents coordinated attacks across multiple authorities.

## References

- Issue location: `programs/factory/src/lib.rs:224-311`
- MAX_PENDING_ACTIONS: `programs/factory/src/lib.rs:822`

