# Unwrap_or Clock Fallback in Root Validation

## Severity: MEDIUM

## Description

The `is_known_root` and `is_expired` functions use `Clock::get().ok().unwrap_or(0)` which silently falls back to 0 if Clock sysvar is unavailable. This could allow bypassing root expiration checks or causing incorrect root validation.

## Vulnerability Details

### Current Implementation

```3662:3669:programs/pool/src/lib.rs
pub fn is_known_root(&self, candidate: &[u8; 32]) -> bool {
    let clock = Clock::get().ok();
    let current_time = clock.map(|c| c.unix_timestamp).unwrap_or(0);
    
    if &self.current_root == candidate {
        return true;
    }
    for idx in 0..self.roots_len as usize {
```

```3856:3860:programs/pool/src/lib.rs
pub fn is_expired(&self) -> bool {
    let clock = Clock::get().ok();
    let current_time = clock.map(|c| c.unix_timestamp).unwrap_or(0);
    current_time > self.expires_at
}
```

### Potential Vulnerabilities

1. **Clock Unavailability**: If Clock sysvar is unavailable (shouldn't happen in normal operation), the fallback to 0 could:
   - Make all roots appear expired (if `expires_at > 0`)
   - Make all roots appear valid (if expiration check uses `current_time == 0`)
   - Cause incorrect root validation

2. **Silent Failure**: The code silently handles Clock unavailability without logging or erroring, which could mask issues.

3. **Root Expiration Bypass**: If Clock fails and falls back to 0, and `expires_at` is positive, the expiration check `0 > expires_at` would be false, potentially allowing expired roots.

## Exploitation Scenario

```rust
// Scenario 1: Clock sysvar unavailable
// 1. Some edge case causes Clock::get() to fail
// 2. Code falls back to current_time = 0
// 3. Root expiration check: 0 > expires_at (if expires_at > 0, this is false)
// 4. Expired roots might be accepted
// 5. Security is compromised

// Scenario 2: Incorrect root validation
// 1. Clock unavailable, current_time = 0
// 2. Root expiration check passes incorrectly
// 3. Old/stale roots might be accepted
```

## Code References

- `is_known_root`: Line 3663-3664
- `is_expired`: Line 3857-3859

## Mitigation

1. **Fail explicitly if Clock is unavailable**:
```rust
pub fn is_known_root(&self, candidate: &[u8; 32]) -> Result<bool> {
    let clock = Clock::get().map_err(|_| PoolError::ClockUnavailable)?;
    let current_time = clock.unix_timestamp;
    
    if &self.current_root == candidate {
        return Ok(true);
    }
    for idx in 0..self.roots_len as usize {
        let root = &self.recent_roots[idx];
        let root_timestamp = self.recent_roots_timestamps[idx];
        
        // Check expiration
        if current_time > root_timestamp + Self::ROOT_EXPIRATION_SECONDS {
            continue; // Root expired, skip
        }
        
        if root == candidate {
            return Ok(true);
        }
    }
    Ok(false)
}
```

2. **Add error type for Clock unavailability**:
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("Clock sysvar unavailable")]
    ClockUnavailable,
}
```

3. **Update callers** to handle the Result type or propagate errors.

4. **Add logging** when Clock is unavailable (if we must handle it gracefully):
```rust
let clock = Clock::get();
let current_time = match clock {
    Ok(c) => c.unix_timestamp,
    Err(e) => {
        msg!("WARNING: Clock unavailable, using fallback: {:?}", e);
        // Consider failing instead of using fallback
        return err!(PoolError::ClockUnavailable);
    }
};
```

## Additional Considerations

- Clock sysvar should always be available in normal Solana operation
- The fallback to 0 might be intentional for edge cases, but should be documented
- Consider whether these functions should return Result<bool> instead of bool

