# Mitigation: Amount Commitments Not Fully Validated in Transfer

## Severity: MEDIUM (upgraded from original - could be HIGH due to supply invariant risk)
## Contract: ptf_pool
## Issue ID: 10/14

## Problem Description

Amount commitments are not in the proof's public inputs, only basic sanity checks (non-zero) are performed. This means amount commitments could be manipulated without affecting proof validation, potentially leading to supply invariant violations.

**Current Code:**
```rust
// Only basic sanity check - non-zero
require!(
    *amount_commit != [0u8; 32],
    PoolError::InvalidPublicInputs
);
```

## Security Impact

1. **Potential for incorrect amount tracking** - Amount commitments not validated against proof
2. **Note ledger inconsistencies** - Ledger could record wrong amounts
3. **Supply invariant violations** - Total supply could become incorrect

## Mitigation Strategies

### Option 1: Update Circuit (RECOMMENDED - Long-term)
**Complexity:** Very High  
**Time:** 4-6 weeks

Update the transfer circuit to include amount commitments in public inputs, similar to unshield circuit.

**Pros:**
- Full validation of amount commitments
- Prevents all manipulation
- Matches unshield circuit behavior

**Cons:**
- Requires new trusted setup
- Breaking change for all clients
- Requires circuit audit

### Option 2: Hash Validation (TEMPORARY - Until Circuit Update)
**Complexity:** Medium  
**Time:** 1 week

Add validation that amount commitments match a hash of the amounts and commitments:

```rust
// In validate_transfer_public_inputs:
// Validate amount commitments match expected hash
// This requires computing expected hash from amounts and commitments
// Note: This is a workaround until circuit includes amount commitments

// For each output, validate amount_commitment is consistent
for (i, (output_commit, amount_commit)) in 
    args.output_commitments.iter()
    .zip(args.output_amount_commitments.iter())
    .enumerate() 
{
    // Basic validation: amount commitment should not be zero
    require!(
        *amount_commit != [0u8; 32],
        PoolError::InvalidPublicInputs
    );
    
    // TODO: Add hash validation once circuit is updated
    // For now, we rely on the fact that amount commitments are recorded
    // in note_ledger and validated during unshield
}
```

### Option 3: Enhanced Note Ledger Validation
**Complexity:** Low  
**Time:** 2-3 days

Add validation in note_ledger that ensures amount commitments are consistent:

```rust
// In record_transfer:
// Validate that amount commitments match what's expected
// This provides defense in depth until circuit is updated
```

## Recommended

**Short-term:** Implement Option 3 as immediate fix  
**Long-term:** Plan Option 1 for next major version

## Testing

1. Test normal transfer - should work as before
2. Test with manipulated amount commitments - should be caught
3. Test note ledger consistency - amounts should match
4. Test unshield after transfer - should validate amounts correctly

## References

- Issue location: `programs/pool/src/lib.rs:3604-3615`
- validate_transfer_public_inputs: `programs/pool/src/lib.rs:3459-3618`
- Note ledger recording: `programs/pool/src/lib.rs:1217-1219`

