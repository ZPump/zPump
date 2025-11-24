# Lock Timeout DoS Vulnerability

## Severity: MEDIUM

## Description

The vault's lock timeout mechanism automatically releases locks after `LOCK_TIMEOUT_SECONDS`. An attacker could exploit this by repeatedly triggering operations that acquire the lock, causing legitimate operations to be blocked or delayed.

## Vulnerability Details

### Current Implementation

```774:798:programs/vault/src/lib.rs
// CRITICAL FIX: Enhanced lock acquisition with timeout
fn acquire_lock(state: &mut VaultState) -> Result<()> {
    let clock = Clock::get()?;
    
    if state.locked {
        if let Some(lock_time) = state.lock_timestamp {
            if clock.unix_timestamp > lock_time + LOCK_TIMEOUT_SECONDS {
                // Lock timed out, release it
                msg!("WARNING: Lock timeout detected, releasing lock");
                state.locked = false;
                state.lock_timestamp = None;
            } else {
                return err!(VaultError::ReentrancyDetected);
            }
        } else {
            // Locked but no timestamp (corrupted state), reset
            msg!("WARNING: Corrupted lock state detected, resetting");
            state.locked = false;
        }
    }
    
    state.locked = true;
    state.lock_timestamp = Some(clock.unix_timestamp);
    Ok(())
}
```

### Potential Vulnerabilities

1. **Lock Timeout Exploitation**: An attacker could:
   - Trigger an operation that acquires the lock
   - Let it timeout
   - Immediately trigger another operation
   - Repeat to keep the vault locked most of the time
   - Cause DoS for legitimate users

2. **No Rate Limiting**: There's no limit on how frequently locks can be acquired/released.

3. **Legitimate Operations Blocked**: If an attacker keeps the lock acquired (via timeout), legitimate operations will be delayed.

## Exploitation Scenario

```rust
// Scenario: Lock timeout DoS
// 1. Attacker calls deposit() which acquires lock
// 2. Transaction succeeds, lock is released
// 3. Attacker immediately calls deposit() again
// 4. If there's any delay, attacker can keep calling
// 5. Legitimate users' operations are blocked
// 6. DoS achieved
```

## Code References

- Lock acquisition: Lines 774-798
- Lock release: Lines 800-804
- LOCK_TIMEOUT_SECONDS constant

## Mitigation

1. **Add rate limiting on lock acquisition**:
```rust
#[account]
pub struct VaultState {
    // ... existing fields ...
    pub last_lock_time: Option<i64>, // Track last lock acquisition time
    pub lock_acquisition_count: u32, // Track lock acquisitions in time window
}

const MIN_TIME_BETWEEN_LOCKS: i64 = 1; // 1 second minimum between locks
const MAX_LOCKS_PER_WINDOW: u32 = 10; // Max 10 locks per time window
const LOCK_WINDOW_SECONDS: i64 = 60; // 60 second window

fn acquire_lock(state: &mut VaultState) -> Result<()> {
    let clock = Clock::get()?;
    
    // CRITICAL FIX: Rate limiting on lock acquisition
    if let Some(last_lock) = state.last_lock_time {
        require!(
            clock.unix_timestamp >= last_lock + MIN_TIME_BETWEEN_LOCKS,
            VaultError::LockRateLimited
        );
    }
    
    // Reset counter if window expired
    if let Some(last_lock) = state.last_lock_time {
        if clock.unix_timestamp > last_lock + LOCK_WINDOW_SECONDS {
            state.lock_acquisition_count = 0;
        }
    }
    
    require!(
        state.lock_acquisition_count < MAX_LOCKS_PER_WINDOW,
        VaultError::LockRateLimited
    );
    
    // ... existing lock logic ...
    
    state.locked = true;
    state.lock_timestamp = Some(clock.unix_timestamp);
    state.last_lock_time = Some(clock.unix_timestamp);
    state.lock_acquisition_count = state.lock_acquisition_count
        .checked_add(1)
        .ok_or(VaultError::LockRateLimited)?;
    Ok(())
}
```

2. **Add error type**:
```rust
#[error_code]
pub enum VaultError {
    // ... existing errors ...
    #[msg("Lock acquisition rate limited")]
    LockRateLimited,
}
```

3. **Increase timeout or make it configurable**:
```rust
// Consider making timeout longer or configurable per vault
// Longer timeout = less susceptible to DoS but more risk of stuck locks
```

4. **Add monitoring and alerting**:
```rust
// Log when lock timeouts occur frequently
// This helps identify DoS attempts
```

## Additional Considerations

- Balance between preventing DoS and allowing legitimate operations
- Consider whether rate limiting should be per-vault or global
- Monitor lock timeout frequency in production

