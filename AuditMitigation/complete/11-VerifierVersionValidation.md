# Mitigation: No Version Validation of Verifying Keys

## Severity: MEDIUM (relevant for long-term security)
## Contract: ptf_verifier_groth16
## Issue ID: 11

## Problem Description

Verifying keys have a version field, but there's no validation that the version being used matches expected versions or that deprecated versions are rejected. Old/insecure verifying keys could continue to be used indefinitely.

## Security Impact

1. **Old/insecure verifying keys could continue to be used** - Deprecated circuit versions remain valid
2. **Cannot gracefully deprecate insecure keys** - No mechanism to reject old versions
3. **Long-term security risk** - Vulnerable circuits remain usable

## Mitigation

Add minimum version checks in both initialization and verification:

```rust
// Add constant for minimum supported version
pub const MIN_SUPPORTED_VERSION: u8 = 1;

pub fn initialize_verifying_key(
    ctx: Context<InitializeVerifyingKey>,
    circuit_tag: [u8; 32],
    verifying_key_id: [u8; 32],
    hash: [u8; 32],
    version: u8,
    verifying_key_data: Vec<u8>,
) -> Result<()> {
    // CRITICAL FIX: Validate minimum version
    require!(
        version >= MIN_SUPPORTED_VERSION,
        VerifierError::VersionTooOld
    );
    
    // ... rest of function
}

pub fn verify_groth16(
    ctx: Context<VerifyGroth16>,
    verifying_key_id: [u8; 32],
    proof: Vec<u8>,
    public_inputs: Vec<u8>,
) -> Result<()> {
    let vk = &ctx.accounts.verifier_state;
    
    // CRITICAL FIX: Validate minimum version before verification
    require!(
        vk.version >= MIN_SUPPORTED_VERSION,
        VerifierError::VersionTooOld
    );
    
    // ... rest of function
}
```

## Additional: Version Deprecation

For future enhancements, consider adding a deprecation mechanism:

```rust
// In VerifyingKeyAccount:
pub deprecated: bool,
pub deprecated_at: Option<i64>,

// Check in verify:
if vk.deprecated {
    let clock = Clock::get()?;
    if let Some(deprecated_at) = vk.deprecated_at {
        require!(
            clock.unix_timestamp < deprecated_at + DEPRECATION_GRACE_PERIOD,
            VerifierError::VersionDeprecated
        );
    }
}
```

## Testing

1. Test initialization with version < MIN_SUPPORTED_VERSION - should fail
2. Test verification with old version - should fail
3. Test normal flow with valid version - should work
4. Test version boundary conditions

## References

- Issue location: `programs/verifier-groth16/src/lib.rs:26-100, 102-152`
- VerifyingKeyAccount struct: `programs/verifier-groth16/src/lib.rs`

