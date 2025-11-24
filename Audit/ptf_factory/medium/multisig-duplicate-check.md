# Multi-Sig Duplicate Signer Check Missing

**Severity:** MEDIUM

**Location:** `programs/factory/src/lib.rs:1257-1284`

## Description

The `require_authority_or_multisig` function checks for multi-sig signatures but doesn't prevent the same signer from being counted multiple times if they appear multiple times in `remaining_accounts`. While `AccessController::require_access` has duplicate prevention, this legacy function doesn't.

## Code Reference

```rust
pub fn require_authority_or_multisig(
    &self,
    authority_key: &Pubkey,
    remaining_accounts: &[AccountInfo],
) -> Result<()> {
    // Check single authority first
    if authority_key == &self.authority {
        return Ok(());
    }
    
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
    
    err!(FactoryError::Unauthorized)
}
```

## Issue

If the same signer appears multiple times in `remaining_accounts`, they could be counted multiple times, potentially allowing a single signer to satisfy a multi-sig threshold.

## Impact

- Single signer could potentially bypass multi-sig requirement
- Security of multi-sig operations could be compromised
- Inconsistent with `AccessController::require_access` which has duplicate prevention

## Current Status

This function appears to be legacy code. Most functions now use `AccessController::require_access` which has proper duplicate signer prevention. However, this function might still be used in some places.

## Recommendation

1. Audit all usages of `require_authority_or_multisig`
2. Replace with `AccessController::require_access` where possible
3. If this function must remain, add duplicate signer tracking:
   ```rust
   let mut seen_signers = std::collections::HashSet::new();
   for signer_pubkey in &self.multi_sig_signers {
       if remaining_accounts.iter().any(|acc| {
           acc.key() == *signer_pubkey && acc.is_signer && seen_signers.insert(*signer_pubkey)
       }) {
           signatures = signatures.checked_add(1)?;
       }
   }
   ```

