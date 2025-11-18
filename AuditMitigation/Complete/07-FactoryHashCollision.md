# Mitigation: Timelock Action Hash Collision Risk

## Severity: CRITICAL
## Contract: ptf_factory
## Issue ID: 7

## Problem Description

Action hash computation doesn't include salt, risking collisions. Two identical actions with different salts would have the same hash.

## Security Impact

1. **Hash Collisions:** Duplicate actions could be incorrectly detected or allowed
2. **Incorrect Deduplication:** Valid actions might be rejected
3. **Security Bypass:** Duplicate actions might be allowed

## Mitigation

Include salt in hash computation OR remove salt entirely:

```rust
// Option 1: Include salt in hash
let action_hash = hashv(&[
    state.key().as_ref(),
    &salt, // ADD SALT HERE
    &action_bytes,
    &execute_after.to_le_bytes(),
]);

// Option 2: Remove salt, use sequence for uniqueness
// Salt is already not needed since sequence provides uniqueness
let action_hash = hashv(&[
    state.key().as_ref(),
    &action_bytes,
    &execute_after.to_le_bytes(),
    &sequence.to_le_bytes(), // Use sequence instead
]);
```

## Recommended

Remove salt from hash (Option 2) since sequence already provides uniqueness. Keep salt in account for other purposes if needed.

## References

- Issue location: `programs/factory/src/lib.rs:242-246`

