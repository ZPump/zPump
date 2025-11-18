# Mitigation: No Validation of Verifying Key Data Size

## Severity: HIGH
## Contract: ptf_factory
## Issue ID: 17

## Problem Description

Verifying key data accepted without size limits, allowing DoS via extremely large keys.

## Mitigation

Add size limit:

```rust
pub const MAX_VERIFYING_KEY_SIZE: usize = 100 * 1024; // 100KB

pub fn create_verifying_key(...) -> Result<()> {
    require!(
        verifying_key_data.len() <= MAX_VERIFYING_KEY_SIZE,
        FactoryError::VerifyingKeyTooLarge
    );
    // ... rest of function
}
```

## References

- Issue location: `programs/factory/src/lib.rs:304-363`

