# zPump Smart Contract Security Audit Report (Post-Fix)

## Executive Summary

This comprehensive security audit covers all four smart contracts in the zPump protocol after initial fixes were applied:
1. **ptf_vault** - Token custody management
2. **ptf_factory** - Mint mapping and twin mint creation
3. **ptf_verifier_groth16** - Zero-knowledge proof verification
4. **ptf_pool** - Core privacy pool operations

**Total Vulnerabilities Found:** 20
- **CRITICAL:** 4
- **HIGH:** 7
- **MEDIUM:** 6
- **LOW:** 3

## Critical Severity Vulnerabilities

### 1. [FACTORY] Action Hash Validation Missing Salt in Execute
**Contract:** ptf_factory  
**Severity:** CRITICAL  
**Impact:** All timelock actions become unexecutable, permanent DoS on factory operations

### 2. [VERIFIER] Dev-Skip Feature Still Present in Production Build
**Contract:** ptf_verifier_groth16  
**Severity:** CRITICAL  
**Impact:** Complete bypass of proof verification if deployed with dev-skip, unlimited token extraction

### 3. [POOL] Transfer Circuit Root Mismatch Still Exists
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Impact:** Proof validation doesn't match actual tree state, potential for invalid state transitions

### 4. [POOL] Unshield Circuit Root Mismatch Still Exists
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Impact:** Same as transfer - proof validation mismatch with actual tree state

## High Severity Vulnerabilities

### 5. [FACTORY] No Rate Limiting on Timelock Actions
**Contract:** ptf_factory  
**Severity:** HIGH  
**Impact:** Temporary DoS by rapidly filling pending action queue

### 6. [FACTORY] Timelock Entry Can Be Cleaned Up While Still Valid
**Contract:** ptf_factory  
**Severity:** HIGH  
**Impact:** Valid actions could be prematurely cleaned up, loss of execution ability

### 7. [POOL] Nullifier Set Reallocation Can Exhaust Payer Funds
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** DoS by exhausting payer's SOL balance, unexpected transaction failures

### 8. [POOL] No Maximum Limit on Nullifier Set Size
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** DoS through account size limits, performance degradation

### 9. [POOL] Shield Finalization Can Still Be Bypassed in Edge Cases
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** Potential for duplicate shields, state inconsistency, double-spending risk

### 10. [POOL] Amount Commitments Not Fully Validated in Transfer
**Contract:** ptf_pool  
**Severity:** MEDIUM (upgraded from original assessment - could be HIGH due to supply invariant risk)  
**Impact:** Potential for incorrect amount tracking, note ledger inconsistencies

### 11. [VERIFIER] No Version Validation of Verifying Keys
**Contract:** ptf_verifier_groth16  
**Severity:** MEDIUM (relevant for long-term security)  
**Impact:** Old/insecure verifying keys could continue to be used

## Medium Severity Vulnerabilities

### 12. [VAULT] Lock State Not Released on CPI Failure
**Contract:** ptf_vault  
**Severity:** MEDIUM  
**Impact:** Permanent DoS if token transfer fails, funds become inaccessible

### 13. [POOL] Public Input Size Limit May Be Too Large
**Contract:** ptf_pool  
**Severity:** MEDIUM  
**Impact:** DoS through expensive parsing, compute unit exhaustion

### 14. [POOL] Amount Commitments Not Fully Validated in Transfer
**Contract:** ptf_pool  
**Severity:** MEDIUM  
**Impact:** Potential for incorrect amount tracking, note ledger inconsistencies

### 15. [FACTORY] Mint PTKN Doesn't Validate Pool Authority Is Signer in Context
**Contract:** ptf_factory  
**Severity:** MEDIUM  
**Impact:** Potential confusion if accounts are misordered

### 16. [VERIFIER] Verifying Key Hash Validation Happens After Account Initialization
**Contract:** ptf_verifier_groth16  
**Severity:** LOW  
**Impact:** Account state could be inconsistent if validation fails

### 17. [VERIFIER] No Expiration or Rotation Mechanism for Verifying Keys
**Contract:** ptf_verifier_groth16  
**Severity:** INFORMATIONAL  
**Impact:** Cannot respond to discovered vulnerabilities in circuits

## Low Severity Vulnerabilities

### 18. [VAULT] No Validation That Pending Authority Change Is For Same Vault
**Contract:** ptf_vault  
**Severity:** LOW  
**Impact:** Theoretical attack vector if PDA derivation fails

### 19. [POOL] Hook Whitelist Contains() Is O(n) Linear Search
**Contract:** ptf_pool  
**Severity:** LOW  
**Impact:** Performance degradation as whitelist grows

### 20. [POOL] No Maximum Size Validation on Output Commitments
**Contract:** ptf_pool  
**Severity:** LOW  
**Impact:** Potential DoS through large output lists

## Informational Issues

### 21. [VAULT] Timelock Duration Not Configurable Per Vault
**Severity:** INFORMATIONAL  
**Impact:** Operational inflexibility

### 22. [VERIFIER] No Expiration or Rotation Mechanism for Verifying Keys
**Severity:** INFORMATIONAL  
**Impact:** Cannot respond to discovered vulnerabilities in circuits

## Summary of Fixes Applied

Previous audit identified and fixed:
- ✅ Reentrancy protection in vault
- ✅ Balance validation in vault
- ✅ Timelock-based authority changes
- ✅ Hash collision fixes in factory
- ✅ Size limits on verifying keys and inputs
- ✅ Cleanup functions for stale timelock actions
- ✅ Nullifier set replaced with deterministic sorted array
- ✅ Public input validation improvements
- ✅ Allowance amount mismatch fixes
- ✅ Hook whitelist removal functionality

## Critical Issues Requiring Immediate Attention

1. **Factory Action Hash Validation** - Blocks all timelock operations
2. **Verifier Dev-Skip Feature** - Could bypass all security if enabled
3. **Pool Circuit Root Mismatches** - Fundamental state validation issues

These must be fixed before production deployment.

