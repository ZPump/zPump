# Shield Claim Expiration Logic

## Severity: MEDIUM

## Description

The `ShieldClaim` has an `expires_at` field and `is_expired()` method, but the expiration logic might not be checked in all code paths, potentially allowing expired claims to be used.

## Vulnerability Details

### Current Implementation

```3855:3860:programs/pool/src/lib.rs
// CRITICAL FIX: Check if claim has expired
pub fn is_expired(&self) -> bool {
    let clock = Clock::get().ok();
    let current_time = clock.map(|c| c.unix_timestamp).unwrap_or(0);
    current_time > self.expires_at
}
```

The expiration check uses `unwrap_or(0)` which could cause issues if Clock is unavailable (same issue as root expiration).

### Potential Vulnerabilities

1. **Expiration Not Checked**: The `is_expired()` method exists, but it might not be called in all code paths where a shield claim is used.

2. **Clock Fallback**: The `unwrap_or(0)` fallback could cause incorrect expiration checks (same as root expiration issue).

3. **Expiration Calculation**: The `expires_at` is set when the claim is activated, but if the expiration duration is miscalculated, claims might expire too early or too late.

4. **Stale Claim Usage**: If an expired claim isn't properly cleaned up, it might be used in unexpected ways.

## Exploitation Scenario

```rust
// Scenario: Expired claim usage
// 1. Shield claim expires
// 2. Code path doesn't check expiration
// 3. Expired claim is used
// 4. Unexpected behavior or exploit

// Scenario: Clock unavailable
// 1. Clock::get() fails
// 2. Falls back to current_time = 0
// 3. Expiration check: 0 > expires_at (if expires_at > 0, this is false)
// 4. Expired claim appears valid
// 5. Security is compromised
```

## Code References

- `is_expired()`: Line 3856
- `expires_at` field in ShieldClaim
- Claim activation (sets expiration)

## Mitigation

1. **Check expiration in all code paths**:
```rust
// Before using shield claim, always check expiration
if shield_claim.is_expired() {
    return err!(PoolError::ShieldClaimExpired);
}
```

2. **Fix Clock fallback** (same as root expiration fix):
```rust
pub fn is_expired(&self) -> Result<bool> {
    let clock = Clock::get().map_err(|_| PoolError::ClockUnavailable)?;
    let current_time = clock.unix_timestamp;
    Ok(current_time > self.expires_at)
}
```

3. **Validate expiration on activation**:
```rust
// When activating claim, validate expiration is reasonable
let clock = Clock::get()?;
let expires_at = clock.unix_timestamp
    .checked_add(SHIELD_CLAIM_EXPIRATION_SECONDS)
    .ok_or(PoolError::TimelockOverflow)?;
    
// Validate expiration is not too far in future
const MAX_EXPIRATION_SECONDS: i64 = 7 * 24 * 60 * 60; // 7 days max
require!(
    expires_at <= clock.unix_timestamp + MAX_EXPIRATION_SECONDS,
    PoolError::InvalidExpiration
);
```

4. **Add cleanup for expired claims**:
```rust
// Add instruction to clean up expired claims
// Or automatically clean up in shield function
if shield_claim.is_expired() {
    shield_claim.deactivate();
    // Continue with new shield
}
```

## Additional Considerations

- Expiration is important for preventing stale claims
- Consider whether expiration should be configurable
- Add monitoring for expired claims
- Document expiration behavior

