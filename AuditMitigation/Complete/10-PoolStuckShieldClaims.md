# Mitigation: Stuck Shield Claim Recovery Logic

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 10

## Problem Description

Complex logic to detect and recover from stuck shield claims could lead to premature deactivation or failure to detect stuck states.

## Security Impact

1. **Double-Spending Risk:** Valid claims might be incorrectly deactivated
2. **Stuck Funds:** Stuck states might not be detected
3. **Race Conditions:** Complex logic increases bug risk

## Mitigation

Simplify stuck claim detection with explicit timeout:

```rust
pub const SHIELD_CLAIM_TIMEOUT_SLOTS: u64 = 100; // ~50 seconds

pub fn shield(...) -> Result<()> {
    // Check for stale claims
    if has_active_claim {
        let claim_age = clock.slot.saturating_sub(shield_claim.created_slot);
        if claim_age > SHIELD_CLAIM_TIMEOUT_SLOTS {
            // Explicitly stale - deactivate
            pool_state.pending_shield.deactivate();
            shield_claim.deactivate();
        } else {
            // Still valid - reject
            return err!(PoolError::PendingShieldInFlight);
        }
    }
    // ... rest of function
}
```

## Testing

Test all edge cases: stale claims, valid claims, race conditions, timeout scenarios.

## References

- Issue location: `programs/pool/src/lib.rs:415-440`

