# zPump Smart Contract Security Audit Report (Post-Fix Verification)

## Executive Summary

This report verifies fixes applied to address security vulnerabilities identified in the previous audit. Overall, **5 out of 9 critical/high issues have been fully fixed**, with **1 partially fixed** and **3 remaining**.

**Total Vulnerabilities Found:** 20  
**Fixes Verified:** 5 ✅  
**Fixes Partially Complete:** 1 ⚠️  
**Fixes Remaining:** 3 ❌  
**New Issues Found:** 2 🔍

- **CRITICAL Remaining:** 2
- **HIGH Remaining:** 1  
- **MEDIUM Remaining:** 3
- **LOW:** 3
- **INFORMATIONAL:** 2

## Fixes Verified as COMPLETE ✅

### 1. [FACTORY] Action Hash Validation Missing Salt in Execute
**Status:** ✅ **FIXED**  
**Location:** `programs/factory/src/lib.rs:416`  
Salt is now correctly included in hash recomputation during execution.

### 2. [FACTORY] No Rate Limiting on Timelock Actions
**Status:** ✅ **FIXED**  
**Location:** `programs/factory/src/lib.rs:238-241, 314, 845, 851`  
60-second rate limiting implemented with `last_action_time` field.

### 3. [FACTORY] Timelock Entry Can Be Cleaned Up While Still Valid
**Status:** ✅ **FIXED**  
**Location:** `programs/factory/src/lib.rs:526-545`  
Cleanup now validates entry hasn't been executed/canceled and checks 30-day threshold.

### 4. [POOL] Nullifier Set Reallocation Can Exhaust Payer Funds
**Status:** ✅ **FIXED**  
**Location:** `programs/pool/src/lib.rs:3210-3222`  
Pre-check added for rent requirement before reallocation.

### 5. [POOL] No Maximum Limit on Nullifier Set Size
**Status:** ✅ **FIXED**  
**Location:** `programs/pool/src/lib.rs:3170, 3202-3205`  
Maximum of 100,000 nullifiers enforced.

## Fixes Partially Complete ⚠️

### 6. [POOL] Shield Finalization Can Still Be Bypassed in Edge Cases
**Status:** ⚠️ **PARTIALLY FIXED**  
**Location:** `programs/pool/src/lib.rs:682-703`  
Stale claim detection added using root mismatch, but no explicit timeout. Root mismatch check works but timeout would be more explicit.

## Critical Issues Remaining ❌

### 1. [VERIFIER] Dev-Skip Feature Still Present in Production Build
**Contract:** ptf_verifier_groth16  
**Severity:** CRITICAL  
**Status:** ❌ **NOT FULLY FIXED**  
**Impact:** Complete bypass of proof verification if deployed with dev-skip enabled

**Current State:**
- Warnings logged when dev-skip enabled
- Compile-time check prevents both features together
- ❌ No compile-time check preventing dev-skip alone in production
- ⚠️ Relies on CI/CD to catch accidental enablement

**Recommendation:** Add compile-time check that panics if dev-skip enabled in non-test builds.

### 2. [POOL] Transfer Circuit Root Mismatch Still Exists
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Status:** ⚠️ **ACKNOWLEDGED** (Circuit-level fix required)  
**Impact:** Proof validation doesn't match actual tree state

**Note:** This requires circuit update and new trusted setup. Cannot be fixed at program level. TODO comments acknowledge the issue.

### 3. [POOL] Unshield Circuit Root Mismatch Still Exists
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Status:** ⚠️ **ACKNOWLEDGED** (Circuit-level fix required)  
**Impact:** Same as transfer - proof validation mismatch

## High Priority Remaining

### 4. [VAULT] Lock State Not Released on CPI Failure
**Contract:** ptf_vault  
**Severity:** MEDIUM (HIGH priority for reliability)  
**Status:** ❌ **NOT FIXED**  
**Impact:** Permanent DoS if token transfer fails

**Recommendation:** Use try-finally pattern or guard struct to always release lock.

## New Issues Discovered 🔍

### 5. [FACTORY] Factory State Migration Issue
**Severity:** MEDIUM  
**Status:** 🔍 **NEW ISSUE**  
**Impact:** Cannot upgrade existing factory deployments due to new `last_action_time` field

**Description:** Existing `FactoryState` accounts don't have `last_action_time` field. Loading these accounts will fail or return wrong values.

**Recommendation:** Add migration instruction or handle missing field gracefully.

### 6. [FACTORY] Rate Limiting Affects All Authorities
**Severity:** LOW  
**Status:** 🔍 **NEW ISSUE**  
**Impact:** Rate limiting is global per factory, not per authority

**Description:** If multiple authorities exist, they share the same rate limit. One authority can block another.

**Recommendation:** Consider per-authority rate limiting if multi-authority support is planned.

## Medium Severity Remaining

### 7. [VAULT] Lock State Not Released on CPI Failure
See High Priority above.

### 8. [POOL] Public Input Size Limit May Be Too Large
**Status:** ❌ Remaining  
10KB limit may allow DoS through expensive parsing.

### 9. [POOL] Amount Commitments Not Fully Validated in Transfer
**Status:** ❌ Remaining  
Amount commitments not in proof's public inputs.

### 10. [FACTORY] Mint PTKN Doesn't Validate Pool Authority Is Signer in Context
**Status:** ❌ Remaining  
Relies on Anchor constraints rather than explicit validation.

### 11. [VERIFIER] Verifying Key Hash Validation Happens After Account Initialization
**Status:** ❌ Remaining  
Account state could be inconsistent if validation fails.

## Low Severity Remaining

### 12. [VAULT] No Validation That Pending Authority Change Is For Same Vault
**Status:** ❌ Remaining

### 13. [POOL] Hook Whitelist Contains() Is O(n) Linear Search
**Status:** ❌ Remaining

### 14. [POOL] No Maximum Size Validation on Output Commitments
**Status:** ❌ Remaining

## Critical Issues Requiring Immediate Attention

1. **Verifier Dev-Skip Compile-Time Protection** - Must prevent accidental deployment
2. **Vault Lock Release on Error** - Prevents permanent DoS
3. **Factory State Migration** - Blocks upgrades to existing deployments
4. **Pool Circuit Root Mismatches** - Requires circuit update (long-term fix)

## Summary

**Progress:** 56% of critical/high issues fixed (5/9)  
**Remaining Critical:** 2  
**Remaining High:** 1  
**New Issues:** 2

**Recommendation:** Fix remaining critical issues (#1, #4) before production deployment. Plan circuit update for root mismatch fixes in next major version.
