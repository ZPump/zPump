# Multi-Sig Duplicate Signer Vulnerability

## Severity: MEDIUM

## Description

The multi-sig validation in `require_authority_or_multisig` doesn't check for duplicate signers in the `multi_sig_signers` vector. An attacker who can configure multi-sig could add the same signer multiple times to reduce the effective threshold.

## Vulnerability Details

### Current Implementation

```1253:1265:programs/factory/src/lib.rs
// Check multi-sig if configured
if !self.multi_sig_signers.is_empty() && self.multi_sig_threshold > 0 {
    let mut signatures = 0u8;
    for signer_pubkey in &self.multi_sig_signers {
        // Check if this signer is in remaining_accounts and is a signer
        if remaining_accounts.iter().any(|acc| acc.key() == *signer_pubkey && acc.is_signer) {
            signatures = signatures.checked_add(1).ok_or(FactoryError::InsufficientSignatures)?;
        }
    }
    require!(
        signatures >= self.multi_sig_threshold,
        FactoryError::InsufficientSignatures
    );
    return Ok(());
}
```

### Potential Vulnerabilities

1. **Duplicate Signers**: If `multi_sig_signers` contains the same pubkey multiple times, a single signer can count multiple times toward the threshold.

2. **Threshold Bypass**: An attacker who can configure multi-sig could:
   - Add the same signer 3 times to `multi_sig_signers`
   - Set threshold to 3
   - Only need 1 actual signer to satisfy the 3-of-N requirement

3. **No Validation on Configuration**: There's no validation when setting multi-sig signers to prevent duplicates.

## Exploitation Scenario

```rust
// Scenario: Duplicate signer attack
// 1. Attacker gains ability to configure multi-sig (via authority or exploit)
// 2. Attacker sets multi_sig_signers = [attacker_key, attacker_key, attacker_key]
// 3. Attacker sets multi_sig_threshold = 3
// 4. Attacker signs once with attacker_key
// 5. Loop counts attacker_key 3 times (once for each entry)
// 6. signatures = 3, threshold = 3, check passes
// 7. Attacker bypasses multi-sig requirement with single signature
```

## Code References

- Multi-sig validation: Lines 1253-1265
- Emergency pause validation: Lines 1281-1291 (similar issue)

## Mitigation

1. **Validate no duplicates when setting multi-sig**:
```rust
pub fn set_multi_sig_signers(
    ctx: Context<SetMultiSig>,
    signers: Vec<Pubkey>,
    threshold: u8,
) -> Result<()> {
    // Validate no duplicates
    let mut seen = std::collections::HashSet::new();
    for signer in &signers {
        require!(
            seen.insert(*signer),
            FactoryError::DuplicateSigner
        );
    }
    
    // Validate threshold is reasonable
    require!(
        threshold > 0 && threshold <= signers.len() as u8,
        FactoryError::InvalidThreshold
    );
    
    // ... set signers ...
}
```

2. **Check for duplicates during validation** (defense in depth):
```rust
// Check multi-sig if configured
if !self.multi_sig_signers.is_empty() && self.multi_sig_threshold > 0 {
    // CRITICAL FIX: Validate no duplicates in signers list
    let mut seen = std::collections::HashSet::new();
    for signer in &self.multi_sig_signers {
        require!(
            seen.insert(*signer),
            FactoryError::DuplicateSigner
        );
    }
    
    let mut signatures = 0u8;
    let mut seen_signers = std::collections::HashSet::new();
    for signer_pubkey in &self.multi_sig_signers {
        // Check if this signer is in remaining_accounts and is a signer
        if remaining_accounts.iter().any(|acc| acc.key() == *signer_pubkey && acc.is_signer) {
            // CRITICAL FIX: Only count each signer once
            if seen_signers.insert(*signer_pubkey) {
                signatures = signatures.checked_add(1).ok_or(FactoryError::InsufficientSignatures)?;
            }
        }
    }
    require!(
        signatures >= self.multi_sig_threshold,
        FactoryError::InsufficientSignatures
    );
    return Ok(());
}
```

3. **Add error type**:
```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("Duplicate signer in multi-sig configuration")]
    DuplicateSigner,
}
```

4. **Apply same fix to emergency_pause_signers** validation.

## Additional Considerations

- This requires authority to configure multi-sig, so impact depends on authority security
- Consider adding validation on initialization as well
- Document that signers must be unique

