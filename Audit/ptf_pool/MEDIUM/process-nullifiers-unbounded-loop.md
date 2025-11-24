# Process Nullifiers Unbounded Loop

## Severity: MEDIUM

## Description

The `process_nullifiers` function loops over all nullifiers in the input without a maximum limit check. While individual nullifier insertion has limits, the loop itself could process a very large number of nullifiers, causing compute budget exhaustion.

## Vulnerability Details

### Current Implementation

```1732:1749:programs/pool/src/lib.rs
fn process_nullifiers<'info>(
    nullifier_set: &mut Account<'info, NullifierSet>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    nullifiers: &[[u8; 32]],
    origin_mint: Pubkey,
    pool_key: &Pubkey,
) -> Result<()> {
    for nullifier in nullifiers {
        // CRITICAL FIX: Use validation function to check integrity
        NullifierSet::insert_with_validation(nullifier_set, payer, system_program, *nullifier, pool_key)?;
        emit!(PTFNullifierUsed {
            mint: origin_mint,
            nullifier: *nullifier,
        });
    }
    Ok(())
}
```

### Potential Vulnerabilities

1. **Compute Budget Exhaustion**: If `nullifiers` array is very large, the loop could consume all compute units, causing transaction failure.

2. **No Maximum Limit**: There's no check on `nullifiers.len()` before the loop, allowing potentially unlimited iterations.

3. **Reallocation Cost**: Each nullifier insertion might trigger reallocation, which is expensive. Processing many nullifiers could cause compute exhaustion.

4. **DoS Attack**: An attacker could provide a large array of nullifiers to cause DoS.

## Exploitation Scenario

```rust
// Scenario: Large nullifier array DoS
// 1. Attacker creates proof with 1000 nullifiers
// 2. process_nullifiers loops over all 1000
// 3. Each insertion might trigger reallocation
// 4. Compute budget is exhausted
// 5. Transaction fails
// 6. Legitimate users are affected
```

## Code References

- `process_nullifiers`: Lines 1732-1749
- Called from: `process_unshield`, `execute_private_transfer`
- Nullifier insertion: `insert_with_validation`

## Mitigation

1. **Add maximum nullifier limit per operation**:
```rust
const MAX_NULLIFIERS_PER_OPERATION: usize = 100; // Reasonable limit

fn process_nullifiers<'info>(
    nullifier_set: &mut Account<'info, NullifierSet>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    nullifiers: &[[u8; 32]],
    origin_mint: Pubkey,
    pool_key: &Pubkey,
) -> Result<()> {
    // CRITICAL FIX: Limit number of nullifiers per operation
    require!(
        nullifiers.len() <= MAX_NULLIFIERS_PER_OPERATION,
        PoolError::TooManyNullifiers
    );
    
    for nullifier in nullifiers {
        NullifierSet::insert_with_validation(nullifier_set, payer, system_program, *nullifier, pool_key)?;
        emit!(PTFNullifierUsed {
            mint: origin_mint,
            nullifier: *nullifier,
        });
    }
    Ok(())
}
```

2. **Add error type**:
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("Too many nullifiers in single operation")]
    TooManyNullifiers,
}
```

3. **Estimate compute cost**:
```rust
// Estimate compute cost based on nullifier count
// Reject if estimated cost exceeds available compute
const COMPUTE_PER_NULLIFIER: u64 = 1000; // Estimate
let estimated_compute = nullifiers.len() as u64 * COMPUTE_PER_NULLIFIER;
// Check against available compute (if accessible)
```

4. **Batch processing**:
```rust
// If nullifiers array is large, consider batching
// But this might require multiple transactions
```

## Additional Considerations

- Individual nullifier insertion has limits (MAX_NULLIFIERS = 100,000)
- But processing many in one operation could exhaust compute
- Consider whether operations should be limited to fewer nullifiers
- Add tests for large nullifier arrays

