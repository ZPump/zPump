# Emergency Pause Duplicate Signer Check Missing

**Severity:** MEDIUM  
**Status:** ✅ MITIGATED

**Location:** `programs/factory/src/lib.rs:1284-1304`

## Description

The `require_emergency_pause_signers` function checks for emergency pause signatures but doesn't prevent the same signer from being counted multiple times if they appear multiple times in `remaining_accounts`. This is similar to the multi-sig issue that was previously identified.

## Code Reference

```rust
pub fn require_emergency_pause_signers(
    &self,
    remaining_accounts: &[AccountInfo],
) -> Result<()> {
    require!(
        !self.emergency_pause_signers.is_empty(),
        FactoryError::EmergencyPauseNotConfigured
    );
    
    let mut signatures = 0u8;
    for signer_pubkey in &self.emergency_pause_signers {
        if remaining_accounts.iter().any(|acc| acc.key() == *signer_pubkey && acc.is_signer) {
            signatures = signatures.checked_add(1).ok_or(FactoryError::InsufficientEmergencySignatures)?;
        }
    }
    require!(
        signatures >= self.emergency_pause_threshold,
        FactoryError::InsufficientEmergencySignatures
    );
    Ok(())
}
```

## Issue

If the same signer appears multiple times in `remaining_accounts`, they could be counted multiple times, potentially allowing a single signer to satisfy the emergency pause threshold if the threshold is low enough.

## Impact

- Single signer could potentially bypass emergency pause threshold requirement
- Security of emergency pause operations could be compromised
- Inconsistent with `AccessController::require_access` which has duplicate prevention

## Attack Scenario

If `emergency_pause_threshold` is set to 2, and only 1 signer is configured, an attacker could:
1. Add the same signer account multiple times to `remaining_accounts`
2. Each occurrence would be counted as a separate signature
3. The threshold of 2 could be satisfied with just 1 actual signer

## Current Status

This function is used for emergency pause operations. While emergency pause is a critical security feature, the duplicate signer vulnerability could allow unauthorized pauses.

## Recommendation

1. ✅ Add duplicate signer tracking similar to what should be done for multi-sig - **FIXED**
   - Added `HashSet` to track seen signers
   - Each signer is only counted once, even if they appear multiple times in `remaining_accounts`

## Mitigation Status

**Fixed in:** Commit d1cf0fd

**Changes Made:**
- Added `seen_signers` HashSet to track duplicate signers (line ~1295)
- Modified signer check to only count each signer once using `seen_signers.insert()`
- Prevents single signer from bypassing threshold by appearing multiple times

## Related Issues

- Similar to the multi-sig duplicate check issue (which was mitigated by using `AccessController::require_access`)
- Emergency pause is a critical security feature, so this should be addressed

