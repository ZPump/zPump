# Mitigation: Nullifier Set Reallocation Can Exhaust Payer Funds

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 7

## Problem Description

When nullifier set needs to grow, it transfers rent from payer (lines 3200-3213). If payer doesn't have sufficient funds or if many nullifiers are inserted in one transaction, the payer could be drained or the transaction could fail unexpectedly.

## Security Impact

1. **DoS by exhausting payer's SOL balance** - Attacker forces multiple reallocations
2. **Unexpected transaction failures** - Legitimate users' transactions fail
3. **Poor UX** - Users don't know why transactions fail or how much SOL needed

## Mitigation Strategies

### Option 1: Pre-check Required Rent (RECOMMENDED)
**Complexity:** Medium  
**Time:** 1 week

Calculate and check required rent before starting transaction:

```rust
pub fn insert<'info>(
    nullifier_set: &mut Account<'info, NullifierSet>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    value: [u8; 32],
) -> Result<()> {
    // ... existing binary search ...
    
    // Calculate space needed
    let current_len = nullifier_set.nullifiers.len();
    let current_space = Self::space_for(current_len);
    let new_space = Self::space_for(current_len + 1);
    
    if new_space > current_space {
        // CRITICAL FIX: Pre-check rent requirement
        let rent_sysvar = Rent::get()?;
        let additional_rent = rent_sysvar.minimum_balance(new_space)
            .saturating_sub(rent_sysvar.minimum_balance(current_space));
        
        // Check payer has sufficient balance BEFORE starting reallocation
        require!(
            payer.lamports() >= additional_rent,
            PoolError::InsufficientRent
        );
        
        // ... existing reallocation code ...
    }
    
    // ... rest of function
}
```

### Option 2: Add Maximum Growth Per Transaction
**Complexity:** Low  
**Time:** 2-3 days

Limit how many nullifiers can be added in one transaction:

```rust
pub const MAX_NULLIFIERS_PER_TRANSACTION: usize = 10;

// In execute_private_transfer and process_unshield:
require!(
    args.nullifiers.len() <= MAX_NULLIFIERS_PER_TRANSACTION,
    PoolError::TooManyNullifiers
);
```

### Option 3: Separate Funding Account
**Complexity:** High  
**Time:** 2-3 weeks

Require a separate funding account for nullifier set growth, or prepay for future growth.

## Recommended

**Combine Options 1 and 2:**
1. Pre-check rent requirement (prevents unexpected failures)
2. Limit nullifiers per transaction (prevents DoS)
3. Add error message explaining rent requirement

## Additional Improvement

Add helper function to estimate rent for transaction:

```rust
pub fn estimate_rent_for_nullifiers(current_count: usize, additional_count: usize) -> Result<u64> {
    let current_space = Self::space_for(current_count);
    let new_space = Self::space_for(current_count + additional_count);
    let rent_sysvar = Rent::get()?;
    Ok(rent_sysvar.minimum_balance(new_space)
        .saturating_sub(rent_sysvar.minimum_balance(current_space)))
}
```

## References

- Issue location: `programs/pool/src/lib.rs:3199-3224`
- NullifierSet::insert: `programs/pool/src/lib.rs:3171-3225`

