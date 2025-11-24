# Timelock Action Expiration Edge Cases

## Severity: MEDIUM

## Description

Timelock actions have expiration times, but there might be edge cases where expired actions aren't properly cleaned up or where expiration checks have race conditions.

## Vulnerability Details

### Current Implementation

```571:575:programs/factory/src/lib.rs
// CRITICAL FIX: Check if action has expired
require!(
    clock.unix_timestamp < entry.expires_at,
    FactoryError::ActionExpired
);
```

Actions expire after `TIMELOCK_STALE_GRACE_SECONDS` (30 days). Expired actions should be cleaned up, but there might be edge cases.

### Potential Vulnerabilities

1. **Expired Action Execution**: If an expired action isn't cleaned up and somehow gets executed, it could cause issues.

2. **Expiration Race Condition**: Between checking expiration and executing, the action might expire, but execution could still proceed.

3. **Cleanup Gaps**: If cleanup fails or isn't called, expired actions could accumulate.

4. **Expiration Calculation**: The expiration is calculated as `queued_at + timelock_duration + TIMELOCK_STALE_GRACE_SECONDS`. If this calculation overflows or is incorrect, expiration might not work correctly.

## Exploitation Scenario

```rust
// Scenario: Expired action execution
// 1. Action is queued with expiration
// 2. Action expires but isn't cleaned up
// 3. Attacker finds way to execute expired action
// 4. Expired action executes, causing issues
```

## Code References

- Expiration check: Lines 571-575
- Expiration calculation: In queue_timelock_action
- Cleanup: cleanup_timelock_action function

## Mitigation

1. **Stricter expiration validation**:
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

    // CRITICAL FIX: Check if action has expired (with buffer to prevent race conditions)
    // Add small buffer to account for clock drift
    const EXPIRATION_BUFFER_SECONDS: i64 = 60; // 1 minute buffer
    require!(
        clock.unix_timestamp < entry.expires_at + EXPIRATION_BUFFER_SECONDS,
        FactoryError::ActionExpired
    );
    
    // CRITICAL FIX: Double-check expiration after hash validation
    // This prevents race conditions where action expires between checks
    let clock_after = Clock::get()?;
    require!(
        clock_after.unix_timestamp < entry.expires_at,
        FactoryError::ActionExpired
    );

    // ... rest of execution ...
}
```

2. **Validate expiration calculation**:
```rust
// In queue_timelock_action, validate expiration calculation
let expires_at = entry.execute_after
    .checked_add(TIMELOCK_STALE_GRACE_SECONDS)
    .ok_or(FactoryError::TimelockOverflow)?;
    
// Validate expiration is reasonable (not too far in future)
const MAX_EXPIRATION_SECONDS: i64 = 365 * 24 * 60 * 60; // 1 year max
require!(
    expires_at <= clock.unix_timestamp + MAX_EXPIRATION_SECONDS,
    FactoryError::InvalidExpiration
);
```

3. **Automatic cleanup on execution**:
```rust
// When executing, check if action is expired and reject
// Don't rely on separate cleanup
```

4. **Add monitoring**:
```rust
// Log when expired actions are attempted to be executed
// Monitor expiration frequency
```

## Additional Considerations

- Expiration is important for preventing stale actions from executing
- Consider whether expiration should be configurable per action type
- Add comprehensive tests for expiration edge cases

