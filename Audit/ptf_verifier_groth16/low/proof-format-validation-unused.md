# Proof Format Validation Function Unused

**Severity:** LOW

**Location:** `programs/verifier-groth16/src/lib.rs:795-803`

## Description

The `validate_proof_format` function is defined but never called. Proof format validation is mentioned as happening during deserialization, but explicit format validation before verification could provide additional security.

## Code Reference

```rust
// CRITICAL FIX: Validate proof format before verification
fn validate_proof_format(proof: &[u8]) -> Result<()> {
    // Groth16 proofs for Bn254 are 192 bytes (2 G1 points + 1 G2 point)
    require!(
        proof.len() >= 192,
        VerifierError::InvalidProofFormat
    );
    Ok(())
}
```

## Impact

- Missing explicit proof format validation before deserialization
- Could allow malformed proofs to reach deserialization, potentially causing issues
- However, deserialization will fail on invalid formats, so impact is low

## Current Status

- Proof format validation happens during deserialization in `groth16_verify`
- Empty proof check exists (line 291)
- Size check exists (MAX_PROOF_SIZE)

## Recommendation

1. Call `validate_proof_format` in `verify_groth16` before deserialization
2. Or remove the function if validation during deserialization is sufficient
3. Consider adding more comprehensive format validation (e.g., check for valid curve points)

