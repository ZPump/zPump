# Mitigation: Transfer Public Input Validation Incomplete

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 14

## Problem Description

Amount commitments are not in proof's public inputs, only basic sanity checks are performed.

## Mitigation

Update circuit to include amount commitments OR add hash validation:

```rust
fn validate_transfer_public_inputs(args: &TransferArgs) -> Result<()> {
    // ... existing validation ...
    
    // ADD: Hash validation for amount commitments
    let mut amount_commit_hash = [0u8; 32];
    for amount_commit in &args.output_amount_commitments {
        amount_commit_hash = hashv(&[&amount_commit_hash, &amount_commit[..]]).to_bytes();
    }
    
    // If circuit is updated to include this hash in public inputs:
    // require!(
    //     fields[amount_hash_index] == amount_commit_hash,
    //     PoolError::PublicInputMismatch
    // );
    
    // For now, ensure all amount commitments are non-zero
    for amount_commit in &args.output_amount_commitments {
        require!(
            *amount_commit != [0u8; 32],
            PoolError::InvalidPublicInputs
        );
    }
    
    Ok(())
}
```

## Long-term

Update circuit to include amount commitments in public inputs for full validation.

## References

- Issue location: `programs/pool/src/lib.rs:3300-3396`

