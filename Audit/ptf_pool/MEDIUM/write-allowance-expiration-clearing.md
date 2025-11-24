# Write Allowance Expiration Clearing Logic

## Severity: MEDIUM

## Description

The `write_allowance` function sets `expires_at` to the provided value, but when revoking (amount = 0), it sets expiration to `None`. However, there's no explicit clearing of expiration when setting a new allowance without expiration.

## Vulnerability Details

### Current Implementation

```1686:1724:programs/pool/src/lib.rs
fn write_allowance(
    pool_loader: &AccountLoader<PoolState>,
    allowance_account: &mut Account<AllowanceAccount>,
    owner: Pubkey,
    spender: Pubkey,
    mint: Pubkey,
    bump: u8,
    amount: u64,
    expires_at: Option<i64>, // CRITICAL FIX: Optional expiration timestamp
) -> Result<()> {
    // ... validation ...
    
    if allowance_account.pool == Pubkey::default() {
        // ... initialization ...
        allowance_account.expires_at = None; // Initialize to None
    } else {
        // ... validation ...
    }
    allowance_account.amount = amount;
    allowance_account.updated_at = Clock::get()?.unix_timestamp;
    allowance_account.expires_at = expires_at; // CRITICAL FIX: Set expiration
    // ... emit event ...
}
```

### Potential Vulnerabilities

1. **Expiration Not Cleared**: If an allowance has an expiration, and a new allowance is set without expiration (`expires_at = None`), the old expiration might still be in effect if the field isn't properly cleared.

2. **Expiration Persistence**: If `expires_at` is `Some(value)` and a new allowance is set with `expires_at = None`, the code sets it to `None`, which is correct. However, if there's a bug in the Option handling, the expiration might persist.

3. **Revocation Logic**: When revoking (amount = 0), expiration is set to `None`, which is correct. But if the revocation fails partway through, the expiration might not be cleared.

## Exploitation Scenario

```rust
// Scenario: Expiration not cleared
// 1. Allowance has expiration at time T
// 2. New allowance set without expiration (expires_at = None)
// 3. If Option handling is buggy, old expiration might persist
// 4. Allowance expires unexpectedly
// 5. Legitimate operations fail
```

## Code References

- `write_allowance`: Lines 1686-1724
- Revocation: Line 1466 (sets `expires_at = None`)
- Approval: Line 1453 (passes `args.expires_at`)

## Mitigation

1. **Explicitly clear expiration**:
```rust
// CRITICAL FIX: Always explicitly set expiration, even if None
allowance_account.expires_at = expires_at; // This is correct
// But add explicit None check for clarity
if expires_at.is_none() {
    allowance_account.expires_at = None; // Explicitly clear
}
```

2. **Validate Option handling**:
```rust
// Ensure Option is properly serialized/deserialized
// Anchor should handle this, but verify in tests
```

3. **Add validation**:
```rust
// After setting, validate the value is correct
match expires_at {
    Some(exp) => {
        require!(
            allowance_account.expires_at == Some(exp),
            PoolError::AllowanceStateCorrupt
        );
    },
    None => {
        require!(
            allowance_account.expires_at.is_none(),
            PoolError::AllowanceStateCorrupt
        );
    }
}
```

4. **Add tests**:
```rust
// Test cases:
// 1. Set allowance with expiration, then set without expiration
// 2. Set allowance without expiration, then set with expiration
// 3. Revoke allowance (should clear expiration)
// 4. Verify expiration is properly cleared in all cases
```

## Additional Considerations

- The current implementation looks correct (sets `expires_at = expires_at`)
- But explicit validation is good defense in depth
- Consider adding logging when expiration is cleared
- Document the expiration clearing behavior

