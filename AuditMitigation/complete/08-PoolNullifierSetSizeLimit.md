# Mitigation: No Maximum Limit on Nullifier Set Size

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 8

## Problem Description

While Solana has a 10MB account limit, there's no explicit maximum on nullifier set size. With 32 bytes per nullifier, this allows ~312,500 nullifiers before hitting account limit. Operations become slower as set grows, and binary search becomes expensive.

## Security Impact

1. **DoS through account size limits** - Hit Solana 10MB account limit
2. **Performance degradation** - Binary search becomes slow with large sets
3. **Transaction failures** - Exceeding account size causes failures

## Mitigation

Add explicit maximum nullifier count:

```rust
impl NullifierSet {
    pub const BASE_SPACE: usize = 8 + 32 + 4; // discriminator + pool + vec length
    pub const MAX_NULLIFIERS: usize = 100_000; // ~3.2MB, leaves room for account overhead
    
    pub fn space_for(count: usize) -> usize {
        Self::BASE_SPACE + (32 * count) // 32 bytes per nullifier
    }
    
    pub fn insert<'info>(
        nullifier_set: &mut Account<'info, NullifierSet>,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        value: [u8; 32],
    ) -> Result<()> {
        // ... existing binary search ...
        
        let current_len = nullifier_set.nullifiers.len();
        
        // CRITICAL FIX: Check maximum nullifier count
        require!(
            current_len < Self::MAX_NULLIFIERS,
            PoolError::NullifierSetFull
        );
        
        // ... rest of insertion logic ...
    }
}
```

## Alternative: Progressive Limits

Implement tiered limits based on pool size/age:

```rust
// Different limits for different pool states
pub const MAX_NULLIFIERS_SMALL: usize = 10_000;
pub const MAX_NULLIFIERS_MEDIUM: usize = 50_000;
pub const MAX_NULLIFIERS_LARGE: usize = 100_000;

// Choose limit based on pool age or total value locked
```

## Recommended

Use fixed 100,000 limit as it:
- Leaves room for account overhead (~3.2MB of 10MB)
- Provides reasonable capacity for years of operation
- Simplifies implementation

## Additional Consideration

If nullifier set becomes full, consider:
1. Archive old nullifiers to separate account
2. Use Merkle tree of nullifiers instead of sorted array
3. Implement nullifier compression/pruning

## References

- Issue location: `programs/pool/src/lib.rs:3147-3232`
- NullifierSet struct: `programs/pool/src/lib.rs:3147-3151`
- Solana account size limit: 10MB

