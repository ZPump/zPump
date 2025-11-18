# Security Audit: ptf_pool

## Overview
The `ptf_pool` program is the core of the zPump system. It manages shielding (deposits), unshielding (withdrawals), private transfers, commitment trees, nullifier sets, and note ledgers. This is the most complex program with the highest security requirements.

## Security Vulnerabilities

### 1. **CRITICAL: Transfer Circuit Root Computation Mismatch**
**Severity:** CRITICAL  
**Location:** `execute_private_transfer()` function (lines 1107-1119)

**Description:**
The transfer circuit computes `new_root = poseidon(old_root, nullifiers)` which doesn't include output commitments. However, the actual tree root after appending outputs is different. The code acknowledges this with a TODO comment but still uses the computed root from the tree (which includes outputs) while the proof only validates the root without outputs.

**Impact:**
- Proof validation doesn't match actual state
- Could allow invalid transfers if output commitments are manipulated
- Root mismatch between proof and actual tree state
- Potential for double-spending or invalid state transitions

**Recommendation:**
- **URGENT:** Update transfer circuit to include output commitments in new_root computation
- Until fixed, add additional validation that output commitments match proof
- Consider disabling private transfers until circuit is fixed
- Add monitoring for root mismatches

---

### 2. **CRITICAL: Unshield Circuit Root Computation Mismatch**
**Severity:** CRITICAL  
**Location:** `process_unshield()` function (lines 1412-1416)

**Description:**
Similar to transfer, the unshield circuit's new_root computation may not include output commitments. The code uses `computed_new_root` from the tree (which includes outputs) but the proof validates a different root.

**Impact:**
- Same as transfer: proof doesn't match actual state
- Could allow invalid unshields
- Potential for state inconsistencies

**Recommendation:**
- **URGENT:** Fix unshield circuit to include output commitments in root
- Add validation that proof root matches tree root after appending
- Consider temporary restrictions until fixed

---

### 3. **CRITICAL: Shield Finalization Can Be Bypassed**
**Severity:** CRITICAL  
**Location:** `shield()` function (lines 610-653)

**Description:**
The shield function checks that `shield_finalize_ledger` is in the same transaction using the instruction sysvar. However, this check can be bypassed if:
- The next instruction is not actually executed (transaction fails)
- The instruction is present but malformed
- The check happens but finalization doesn't complete

**Impact:**
- Tokens could be deposited without finalization
- Shield claims could be left in inconsistent state
- Potential for stuck funds

**Recommendation:**
- Make shield and finalize_ledger atomic (single instruction)
- Add state checks after finalization
- Consider requiring finalization in same instruction, not just transaction
- Add timeout mechanism for stuck shields

---

### 4. **CRITICAL: Nullifier Set Uses Bloom Filter (False Positives)**
**Severity:** CRITICAL  
**Location:** `NullifierSet` struct and `insert()` function (lines 3037-3094)

**Description:**
The nullifier set uses a bloom filter which can have false positives (incorrectly reporting a nullifier as used when it's not). While the code comment says "false positives are acceptable (they just prevent double-spending)", this is actually a denial-of-service vulnerability.

**Impact:**
- Legitimate users could be prevented from spending their notes
- False positives mean valid nullifiers are rejected
- No way to recover from false positives
- Permanent DoS for affected users

**Recommendation:**
- Replace bloom filter with deterministic set (hash set, Merkle tree, etc.)
- If bloom filter must be used, add mechanism to handle false positives
- Consider using a hybrid approach (bloom filter + confirmation set)
- Add monitoring for false positive rate

---

### 5. **HIGH: Stuck Shield Claim Recovery Logic is Complex**
**Severity:** HIGH  
**Location:** `shield()` function (lines 415-440)

**Description:**
The code has complex logic to detect and recover from stuck shield claims. This logic tries to deactivate pending_shield if the claim is stale, but the conditions are complex and could lead to:
- Premature deactivation of valid claims
- Failure to detect actual stuck states
- Race conditions between shield and finalization

**Impact:**
- Could allow double-spending if claims are incorrectly deactivated
- Could prevent legitimate shields if stuck detection fails
- Complex logic increases bug risk

**Recommendation:**
- Simplify stuck claim detection
- Add explicit timeout mechanism
- Use clearer state machine
- Add comprehensive tests for all edge cases

---

### 6. **HIGH: Allowance Amount Mismatch Check**
**Severity:** HIGH  
**Location:** `transfer_from()` function (lines 956-962)

**Description:**
The code checks that `allowance_amount == spend_amount`, but this doesn't account for fees. If a transfer includes fees, the actual spend might be less than allowance_amount, but the check requires exact match.

**Impact:**
- Could prevent valid transfers if fees are involved
- Check might be too strict
- Could cause user confusion

**Recommendation:**
- Clarify what spend_amount represents (with or without fees)
- Update check to account for fees if needed
- Document the expected behavior clearly

---

### 7. **HIGH: Hook Whitelist Can Be DoS'd**
**Severity:** HIGH  
**Location:** `HookWhitelist` struct (lines 3561-3575)

**Description:**
The whitelist has a maximum of 100 programs (`MAX_PROGRAMS`), but there's no mechanism to remove programs once added. If the whitelist fills up, no new hooks can be added.

**Impact:**
- Permanent DoS once whitelist is full
- No way to remove malicious or unused hooks
- Could prevent legitimate hooks from being added

**Recommendation:**
- Add function to remove hooks from whitelist
- Add governance mechanism for whitelist management
- Consider increasing MAX_PROGRAMS or making it dynamic
- Add monitoring for whitelist capacity

---

### 8. **HIGH: No Size Limits on Public Inputs**
**Severity:** HIGH  
**Location:** `parse_field_elements()` function (lines 3274-3283)

**Description:**
The function parses public inputs without size limits. An attacker could submit extremely large public inputs, causing:
- Compute unit exhaustion
- Memory issues
- DoS attacks

**Impact:**
- DoS by submitting large inputs
- Could cause transaction failures
- Potential for integer overflow

**Recommendation:**
- Add maximum size limit (e.g., 10KB)
- Validate size before parsing
- Reject oversized inputs immediately

---

### 9. **HIGH: Transfer Public Input Validation is Incomplete**
**Severity:** HIGH  
**Location:** `validate_transfer_public_inputs()` function (lines 3300-3396)

**Description:**
The function validates output commitments match the proof, but acknowledges that `output_amount_commitments` are not in the proof's public inputs. It only does basic sanity checks (non-zero) but doesn't fully validate them.

**Impact:**
- Amount commitments could be manipulated
- Could allow invalid transfers
- Incomplete validation leaves attack surface

**Recommendation:**
- Update circuit to include amount commitments in public inputs
- Add full validation of amount commitments
- Until circuit is updated, add additional checks

---

### 10. **MEDIUM: Invariant Checks Are Optional**
**Severity:** MEDIUM  
**Location:** Invariant enforcement (lines 1728-1750, feature-gated)

**Description:**
Invariant checks are behind a feature flag and only enforced conditionally (based on amount thresholds and sampling). This means:
- Small transfers might not be validated
- Invariant breaches could go undetected
- Sampling means some breaches might be missed

**Impact:**
- Supply inconsistencies could accumulate
- Small-scale attacks might go undetected
- Reduced security for low-value operations

**Recommendation:**
- Make invariant checks mandatory for all operations
- Remove amount thresholds
- Consider making it always-on feature
- Add monitoring for skipped checks

---

### 11. **MEDIUM: Tree Can Fill Up**
**Severity:** MEDIUM  
**Location:** `CommitmentTree` append functions (lines 2587-2770)

**Description:**
The tree has a maximum depth of 32 (2^32 leaves), but once full, no new commitments can be added. There's no mechanism to:
- Migrate to a new tree
- Expand the tree
- Handle full tree scenario

**Impact:**
- Permanent DoS once tree is full
- No way to continue operations
- Would require new pool deployment

**Recommendation:**
- Add tree migration mechanism
- Consider using multiple trees
- Add monitoring for tree capacity
- Plan for tree expansion

---

### 12. **MEDIUM: Recent Roots Array Has Limited Size**
**Severity:** MEDIUM  
**Location:** `PoolState` struct (line 2814, MAX_ROOTS = 16)

**Description:**
The `recent_roots` array only stores 16 roots. If a proof references an older root, it will be rejected even if valid. This limits the time window for proof submission.

**Impact:**
- Valid proofs could be rejected if root is too old
- Limits operational flexibility
- Could cause issues during network congestion

**Recommendation:**
- Increase MAX_ROOTS or make it dynamic
- Consider using a more efficient data structure
- Add mechanism to verify older roots
- Document root retention policy

---

### 13. **MEDIUM: Hook Account Validation is Lenient in Lenient Mode**
**Severity:** MEDIUM  
**Location:** `validate_hook_keys()` function (lines 3890-3916)

**Description:**
In "Lenient" mode, hook accounts only need to be present somewhere in the provided accounts, not in the exact order. This could allow:
- Account substitution attacks
- Unintended account access
- Reduced security

**Impact:**
- Could allow malicious accounts to be passed to hooks
- Less strict validation
- Potential for hook exploitation

**Recommendation:**
- Prefer Strict mode by default
- Document security implications of Lenient mode
- Add warnings when Lenient mode is used
- Consider deprecating Lenient mode

---

### 14. **LOW: No Rate Limiting on Operations**
**Severity:** LOW  
**Location:** All operation functions

**Description:**
There's no rate limiting on shield, unshield, or transfer operations. An attacker could spam the system with many operations, potentially:
- Filling up the tree quickly
- Exhausting compute units
- Causing DoS

**Impact:**
- Potential for spam attacks
- Could accelerate tree filling
- Increased costs

**Recommendation:**
- Consider adding rate limiting per user
- Add fees to discourage spam
- Monitor for unusual activity patterns

---

### 15. **LOW: Protocol Fees Never Collected**
**Severity:** LOW  
**Location:** `PoolState` struct (line 2820, `protocol_fees` field)

**Description:**
Protocol fees are accumulated in `protocol_fees` but there's no function to collect them. Fees accumulate indefinitely with no way to withdraw.

**Impact:**
- Fees are locked forever
- No way to use accumulated fees
- Could be significant amount over time

**Recommendation:**
- Add function to collect protocol fees
- Require authority or governance to collect
- Add maximum fee cap if needed

---

### 16. **LOW: No Validation of Commitment Uniqueness**
**Severity:** LOW  
**Location:** Tree append functions

**Description:**
The code doesn't check if a commitment has already been added to the tree. While this might be intentional (allowing same commitment multiple times), it could lead to:
- Duplicate commitments in tree
- Potential for confusion
- Unclear semantics

**Impact:**
- Could allow duplicate commitments
- Makes tree state less clear
- Potential for issues in downstream systems

**Recommendation:**
- Consider checking for duplicate commitments
- Document whether duplicates are allowed
- Add monitoring for duplicate commitments

---

### 17. **INFORMATIONAL: Complex State Machine for Shield Claims**
**Severity:** INFORMATIONAL  
**Location:** `ShieldClaim` status management (lines 2905-3033)

**Description:**
The shield claim has a complex state machine with multiple statuses (INACTIVE, PENDING_TREE, AWAITING_LEDGER, AWAITING_INVARIANT, LEDGER_COMPLETE). The transitions are complex and could lead to bugs.

**Impact:**
- Complex logic increases bug risk
- Hard to reason about all states
- Could lead to edge cases

**Recommendation:**
- Simplify state machine if possible
- Add comprehensive state transition tests
- Document all valid transitions
- Consider using state machine library

---

## Positive Security Features

1. **Proof Verification:** All operations require valid Groth16 proofs
2. **Nullifier Tracking:** Prevents double-spending (though bloom filter has issues)
3. **Root Validation:** Validates Merkle roots before operations
4. **Public Input Validation:** Validates public inputs match proof
5. **Hook Whitelist:** Only whitelisted hooks can be called
6. **Mint Status Checking:** Validates mints are active before operations
7. **Supply Invariant:** Tracks supply consistency (when enabled)
8. **Authority Validation:** Proper PDA and signer validation

---

## Summary

The pool program has several critical security issues:
- **CRITICAL:** Transfer and unshield circuit root computations don't match actual tree state
- **CRITICAL:** Nullifier set uses bloom filter with false positives (DoS risk)
- **CRITICAL:** Shield finalization can potentially be bypassed
- **HIGH:** Multiple validation gaps and DoS risks
- **MEDIUM:** Optional invariant checks and tree capacity limits

The most urgent issues are:
1. Fix transfer/unshield circuits to include output commitments in root
2. Replace bloom filter with deterministic nullifier set
3. Make shield finalization truly atomic
4. Add comprehensive input validation and size limits

The program is complex and well-designed overall, but these issues need immediate attention before mainnet deployment.

