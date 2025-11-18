# Mitigation: No Size Limits on Public Inputs

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 13

## Problem Description

Public inputs are parsed without size limits, allowing DoS attacks via extremely large inputs.

## Mitigation

Add size limits to `parse_field_elements()`:

```rust
pub const MAX_PUBLIC_INPUTS_SIZE: usize = 10 * 1024; // 10KB

fn parse_field_elements(bytes: &[u8]) -> Result<Vec<[u8; 32]>> {
    require!(
        bytes.len() <= MAX_PUBLIC_INPUTS_SIZE,
        PoolError::PublicInputsTooLarge
    );
    require!(bytes.len() % 32 == 0, PoolError::InvalidPublicInputs);
    // ... rest of function
}
```

## References

- Issue location: `programs/pool/src/lib.rs:3274-3283`

