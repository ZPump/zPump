# Security Audit: ptf_vault (Post-Fix)

## Overview
The `ptf_vault` program manages custodial SPL tokens. Previous critical issues have been addressed with reentrancy protection, balance validation, and timelock-based authority changes.

## Security Vulnerabilities

### 1. **MEDIUM: Lock State Not Released on CPI Failure**
**Severity:** MEDIUM  
**Location:** `deposit()` and `release()` functions (lines 28-113)

**Description:**
The reentrancy lock (`vault_state.locked = true`) is set before CPI calls but only released on successful completion. If the token transfer CPI fails, the lock remains set, permanently DoS'ing the vault.

**Impact:**
- Permanent DoS if token transfer fails
- Funds become inaccessible
- Requires manual intervention or program upgrade

**Recommendation:**
Use a try-finally pattern or ensure lock is always released:

```rust
vault_state.locked = true;
let result = token_interface::transfer(cpi_ctx, amount);
vault_state.locked = false; // Always release, even on error
result?; // Propagate error after releasing lock
```

### 2. **LOW: No Validation That Pending Authority Change Is For Same Vault**
**Severity:** LOW  
**Location:** `execute_authority_change()` function (lines 163-202)

**Description:**
While `pending_change.vault_state` is validated against `state.key()`, there's no explicit check that the pending change account's PDA derivation matches the vault_state being modified.

**Impact:**
- Theoretical attack vector if PDA derivation fails
- Low probability but could cause state inconsistency

**Recommendation:**
Add explicit PDA validation:

```rust
let (expected_pending_change, expected_bump) = Pubkey::find_program_address(
    &[b"pending-auth", state.key().as_ref()],
    &crate::ID,
);
require_keys_eq!(
    ctx.accounts.pending_change.key(),
    expected_pending_change,
    VaultError::InvalidPendingChange
);
```

### 3. **INFORMATIONAL: Timelock Duration Not Configurable Per Vault**
**Severity:** INFORMATIONAL  
**Location:** `propose_authority_change()` function (lines 119-160)

**Description:**
Timelock duration is hardcoded to 7 days. This may be too short or too long for different use cases.

**Impact:**
- Operational inflexibility
- Cannot adjust security parameters per deployment

**Recommendation:**
Consider making timelock duration configurable per vault or adding ability to adjust with governance.

