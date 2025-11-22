# No Verifying Key Size Limit

## Severity: MEDIUM

## Description

The verifier program does not enforce a maximum size limit on verifying keys during registration. While there are limits for proofs (`MAX_PROOF_SIZE`) and public inputs (`MAX_PUBLIC_INPUTS_SIZE`), there's no `MAX_VERIFYING_KEY_SIZE` constant or validation. This could allow DoS attacks through excessively large keys or account space exhaustion.

## Vulnerability Details

### Current Implementation

- `MAX_PROOF_SIZE`: 10KB (line 11)
- `MAX_PUBLIC_INPUTS_SIZE`: 2KB (line 13)
- No `MAX_VERIFYING_KEY_SIZE`: Missing
- Account space calculation: Uses `verifying_key_data.len()` directly (line 196)

### Potential Vulnerabilities

1. **Account Space Exhaustion**: An attacker could register a very large verifying key (e.g., 1MB), consuming excessive account space and rent.

2. **DoS During Deserialization**: Large keys require more compute units to deserialize, potentially causing transactions to exceed compute limits.

3. **Memory/Storage Costs**: Large keys increase storage costs and could impact network performance.

4. **Unbounded Growth**: Without limits, keys could grow indefinitely, making the system unsustainable.

## Exploitation Scenario

```rust
// Scenario 1: Account space exhaustion
// 1. Attacker creates a 1MB "verifying key" (could be mostly padding)
// 2. Attacker computes hash of the large data
// 3. Attacker calls initialize_verifying_key
// 4. Account requires significant rent (potentially thousands of SOL)
// 5. If payer is compromised or if factory pays, resources are wasted

// Scenario 2: Compute budget exhaustion
// 1. Attacker registers large key
// 2. During verification, deserialization of large key consumes excessive compute
// 3. Transaction fails or requires very high compute budget
// 4. System becomes unusable or expensive

// Scenario 3: Storage bloat
// 1. Multiple large keys are registered
// 2. On-chain storage grows significantly
// 3. Network performance degrades
// 4. Costs increase for all users
```

## Code References

- Proof size limit: `MAX_PROOF_SIZE` (line 11)
- Public inputs size limit: `MAX_PUBLIC_INPUTS_SIZE` (line 13)
- Account space calculation: `VerifyingKeyAccount::space(verifying_key_data.len())` (line 196)
- No verifying key size check in `initialize_verifying_key`

## Mitigation

1. **Add Size Limit Constant**: Define a maximum size for verifying keys:

```rust
/// Maximum verifying key byte length
/// Groth16 verifying keys for Bn254 are typically ~1-10KB
/// 100KB provides plenty of headroom while preventing abuse
pub const MAX_VERIFYING_KEY_SIZE: usize = 100 * 1024;
```

2. **Enforce Limit During Registration**: Add validation in `initialize_verifying_key`:

```rust
pub fn initialize_verifying_key(
    ctx: Context<InitializeVerifyingKey>,
    circuit_tag: [u8; 32],
    verifying_key_id: [u8; 32],
    hash: [u8; 32],
    version: u8,
    verifying_key_data: Vec<u8>,
) -> Result<()> {
    // ... existing checks ...
    
    require!(
        verifying_key_data.len() <= MAX_VERIFYING_KEY_SIZE,
        VerifierError::VerifyingKeyTooLarge
    );
    
    // ... rest of function ...
}
```

3. **Add Error Type**: Add error variant for oversized keys:

```rust
#[error_code]
pub enum VerifierError {
    // ... existing errors ...
    #[msg("verifying key exceeds maximum allowed size")]
    VerifyingKeyTooLarge,
}
```

4. **Consider Minimum Size**: Also validate minimum size to prevent extremely small invalid keys:

```rust
pub const MIN_VERIFYING_KEY_SIZE: usize = 100; // Minimum expected size

require!(
    verifying_key_data.len() >= MIN_VERIFYING_KEY_SIZE,
    VerifierError::VerifyingKeyTooSmall
);
```

5. **Document Size Expectations**: Document expected key sizes for different circuit types to help developers.

6. **Monitor Key Sizes**: Add logging/events to track key sizes for monitoring.

