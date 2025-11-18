# Security Audit: ptf_factory

## Overview
The `ptf_factory` program manages mint-to-pool mappings, creates twin mints (PTKN), and handles verifying key registration. It includes a timelock system for critical operations.

## Security Vulnerabilities

### 1. **CRITICAL: Timelock Action Hash Collision Risk**
**Severity:** CRITICAL  
**Location:** `queue_timelock_action()` function (lines 223-302)

**Description:**
The action hash is computed without including the salt in the hash calculation (line 242-246). While the salt is stored in the account, it's not used in the hash computation for deduplication. This means:
- Two identical actions with different salts would have the same hash
- The duplicate check (line 249-252) could incorrectly reject valid actions
- Or worse, allow duplicate actions if salt differs

**Impact:**
- Potential for hash collisions leading to incorrect duplicate detection
- Could allow duplicate actions to be queued
- Could prevent valid actions from being queued

**Recommendation:**
- Include salt in hash computation OR remove salt from hash entirely
- Ensure hash uniquely identifies the action
- Add sequence number to hash to guarantee uniqueness

---

### 2. **CRITICAL: Sequence Overflow Not Fully Protected**
**Severity:** CRITICAL  
**Location:** `queue_timelock_action()` function (lines 274-278)

**Description:**
While there's a check for sequence overflow using `checked_add()`, if the sequence reaches u64::MAX, the system would be permanently broken. There's no mechanism to reset or handle this edge case.

**Impact:**
- If sequence reaches maximum value, no new timelock actions can be queued
- Permanent DoS of timelock system
- Would require program redeployment to fix

**Recommendation:**
- Add sequence wrapping mechanism (unlikely to reach u64::MAX in practice)
- Add monitoring/alerting for high sequence values
- Consider using u128 for sequence if needed

---

### 3. **HIGH: Pending Action Hashes Vector Can Grow Unbounded**
**Severity:** HIGH  
**Location:** `FactoryState` struct (line 736) and `queue_timelock_action()` (line 293)

**Description:**
The `pending_action_hashes` vector has a maximum size check (line 256), but if actions are not properly cleaned up, the vector could fill up. The cleanup happens in `execute_timelock_action()` and `cancel_timelock_action()`, but if these are never called, the vector fills up.

**Impact:**
- DoS attack by queuing many actions and never executing/canceling them
- Once MAX_PENDING_ACTIONS (50) is reached, no new actions can be queued
- Could permanently disable timelock system

**Recommendation:**
- Add automatic cleanup of stale actions (e.g., after 30 days)
- Implement a cleanup function that can remove old pending actions
- Consider using a more efficient data structure (e.g., hash set)

---

### 4. **HIGH: No Validation of Verifying Key Data Size**
**Severity:** HIGH  
**Location:** `create_verifying_key()` function (lines 304-363)

**Description:**
The function accepts `verifying_key_data: Vec<u8>` without size limits. While the hash is verified, there's no check on the maximum size of the verifying key data.

**Impact:**
- Could cause account size issues if key is too large
- Potential for DoS if extremely large keys are submitted
- Could exhaust compute units during hash computation

**Recommendation:**
- Add maximum size limit for verifying_key_data
- Validate size before hash computation
- Consider chunked processing for large keys

---

### 5. **HIGH: Mint PTKN Function Lacks Comprehensive Validation**
**Severity:** HIGH  
**Location:** `mint_ptkn()` function (lines 489-549)

**Description:**
The function validates pool_authority but doesn't verify:
- The pool_authority actually controls the pool
- The pool is in a valid state
- The mint amount doesn't exceed reasonable limits
- The destination account is valid

**Impact:**
- Could mint tokens to invalid accounts
- No protection against minting excessive amounts
- Could be exploited if pool_authority is compromised

**Recommendation:**
- Add amount limits (maximum mint per transaction)
- Validate destination account more thoroughly
- Consider rate limiting for mint operations
- Verify pool state before minting

---

### 6. **MEDIUM: Timelock Minimum Duration Enforcement**
**Severity:** MEDIUM  
**Location:** `initialize_factory()` function (lines 36-39)

**Description:**
While there's a minimum timelock check (24 hours), this is only enforced at initialization. If the timelock is set to the minimum, it may be too short for critical operations.

**Impact:**
- 24 hours may be insufficient for high-value operations
- No way to increase timelock after initialization
- Could allow rapid changes if authority is compromised

**Recommendation:**
- Consider increasing minimum to 48-72 hours
- Allow governance to increase timelock (but not decrease)
- Add different timelock durations for different action types

---

### 7. **MEDIUM: Freeze Authority Not Fully Validated**
**Severity:** MEDIUM  
**Location:** `prepare_ptkn_mint()` function (lines 909-919)

**Description:**
The function checks if freeze authority is not None and not the factory, but it rejects the mint entirely. However, there's no way to set freeze authority to None if it's currently set to a different value.

**Impact:**
- Reused mints with non-factory freeze authority are rejected
- No way to recover from this situation
- Could prevent legitimate mint registration

**Recommendation:**
- Allow setting freeze authority to None if current authority signs
- Add a separate function to update freeze authority
- Document freeze authority requirements clearly

---

### 8. **MEDIUM: Action Hash Recalculation in Execute Could Fail**
**Severity:** MEDIUM  
**Location:** `execute_timelock_action()` function (lines 376-390)

**Description:**
The action hash is recalculated during execution to verify it hasn't been tampered with. However, if the serialization format changes or there's a bug in serialization, the hash won't match even for valid actions.

**Impact:**
- Valid actions could be rejected if serialization changes
- Could prevent execution of legitimate queued actions
- No way to recover from hash mismatch

**Recommendation:**
- Ensure serialization is stable and versioned
- Add version field to TimelockAction enum
- Consider storing serialized bytes instead of enum

---

### 9. **LOW: No Rate Limiting on Mint Registration**
**Severity:** LOW  
**Location:** `register_mint()` function (lines 76-148)

**Description:**
There's no rate limiting on mint registration. An attacker could spam the factory with many mint registrations, potentially causing:
- Account creation spam
- Increased storage costs
- Potential DoS

**Impact:**
- Could fill up account space
- Increased costs for legitimate users
- Potential for spam attacks

**Recommendation:**
- Add rate limiting per authority
- Consider requiring fees for registration
- Add maximum mints per authority

---

### 10. **LOW: Pause Function Has No Timelock**
**Severity:** LOW  
**Location:** `pause()` function (lines 205-212)

**Description:**
The pause function can be called immediately by the authority without timelock. While this may be intentional for emergency situations, it means:
- No protection against compromised authority instantly pausing
- Could be used maliciously to freeze all operations
- No way for users to react

**Impact:**
- Instant DoS if authority is compromised
- No time for users to withdraw or react
- Could be used as an attack vector

**Recommendation:**
- Consider requiring timelock for pause (with emergency override)
- Add multi-sig requirement for pause
- Allow users to withdraw even when paused

---

### 11. **INFORMATIONAL: Direct Updates Completely Disabled**
**Severity:** INFORMATIONAL  
**Location:** `ensure_direct_update_allowed()` function (lines 783-788)

**Description:**
The function always returns an error, completely disabling direct updates. While this forces all updates through timelock (good for security), it means:
- No way to make urgent fixes
- All changes require 24+ hour delay
- Could impact operational flexibility

**Impact:**
- Good security practice but reduces flexibility
- No emergency update mechanism
- Could delay critical fixes

**Recommendation:**
- Consider adding emergency update mechanism with multi-sig
- Document the trade-off clearly
- Ensure timelock duration is appropriate for all use cases

---

## Positive Security Features

1. **Timelock System:** Well-implemented timelock for critical operations
2. **Hash Verification:** Action hashes are verified before execution
3. **Duplicate Prevention:** System prevents duplicate actions
4. **Authority Validation:** Proper validation of pool_authority in mint_ptkn
5. **Freeze Authority Protection:** Attempts to prevent freeze authority attacks
6. **Mint Status Checking:** Validates mint status before operations

---

## Summary

The factory program has a robust timelock system, but there are several critical issues:
- Action hash computation doesn't include salt, risking collisions
- Sequence overflow could permanently break the system
- Pending action hashes vector can be DoS'd
- Missing size limits on verifying key data
- Mint PTKN function needs more validation

The most critical issues are around the timelock system's hash computation and the potential for DoS attacks on the pending actions vector. The program would benefit from better cleanup mechanisms and more comprehensive validation.

