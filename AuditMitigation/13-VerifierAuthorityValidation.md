# Mitigation: Authority Validation Only Checks Owner

## Severity: HIGH
## Contract: ptf_verifier_groth16
## Issue ID: 15

## Problem Description

Function checks authority is owned by factory program but doesn't verify it's specifically the factory_state PDA.

## Mitigation

Verify authority is factory_state PDA:

```rust
pub fn initialize_verifying_key(...) -> Result<()> {
    // Verify authority is factory_state PDA
    let (expected_factory_state, _) = Pubkey::find_program_address(
        &[seeds::FACTORY, PTF_FACTORY_PROGRAM_ID.as_ref()],
        &PTF_FACTORY_PROGRAM_ID,
    );
    
    require_keys_eq!(
        ctx.accounts.authority.key(),
        expected_factory_state,
        VerifierError::UnauthorizedAuthority
    );
    
    // ... rest of function
}
```

## References

- Issue location: `programs/verifier-groth16/src/lib.rs:52-62`

