# Mitigation: No Size Limits on Proof and Public Inputs

## Severity: CRITICAL
## Contract: ptf_verifier_groth16
## Issue ID: 6

## Problem Description

The `verify_groth16()` function accepts `proof: Vec<u8>` and `public_inputs: Vec<u8>` without size limits, allowing DoS attacks via extremely large inputs.

## Security Impact

1. **DoS Attacks:** Extremely large proofs/inputs can exhaust compute units
2. **Memory Issues:** Large inputs could cause memory problems
3. **Transaction Failures:** Valid transactions might fail due to size

## Mitigation

Add maximum size limits and validate before processing:

```rust
pub const MAX_PROOF_SIZE: usize = 10 * 1024; // 10KB
pub const MAX_PUBLIC_INPUTS_SIZE: usize = 2 * 1024; // 2KB

pub fn verify_groth16(...) -> Result<()> {
    // Validate sizes FIRST (fail fast)
    require!(
        proof.len() <= MAX_PROOF_SIZE,
        VerifierError::ProofTooLarge
    );
    require!(
        public_inputs.len() <= MAX_PUBLIC_INPUTS_SIZE,
        VerifierError::PublicInputsTooLarge
    );
    require!(!proof.is_empty(), VerifierError::EmptyProof);
    require!(!public_inputs.is_empty(), VerifierError::EmptyPublicInputs);
    
    // ... rest of function
}
```

## Testing

Test with maximum sizes, oversized inputs, and edge cases.

## References

- Issue location: `programs/verifier-groth16/src/lib.rs:87-129`

