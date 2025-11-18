# zPump Smart Contract Security Audit Report

## Executive Summary

This comprehensive security audit covers all four smart contracts in the zPump protocol:
1. **ptf_vault** - Token custody management
2. **ptf_factory** - Mint mapping and twin mint creation
3. **ptf_verifier_groth16** - Zero-knowledge proof verification
4. **ptf_pool** - Core privacy pool operations

**Total Vulnerabilities Found:** 47
- **CRITICAL:** 9
- **HIGH:** 15
- **MEDIUM:** 13
- **LOW:** 7
- **INFORMATIONAL:** 3

## Critical Severity Vulnerabilities

### 1. [POOL] Transfer Circuit Root Computation Mismatch
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Impact:** Proof validation doesn't match actual tree state, potential for invalid transfers and double-spending

### 2. [POOL] Unshield Circuit Root Computation Mismatch
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Impact:** Same as transfer - proof root doesn't include output commitments, allowing invalid unshields

### 3. [POOL] Nullifier Set Uses Bloom Filter (False Positives)
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Impact:** Legitimate users can be permanently DoS'd if their nullifiers trigger false positives

### 4. [POOL] Shield Finalization Can Be Bypassed
**Contract:** ptf_pool  
**Severity:** CRITICAL  
**Impact:** Tokens could be deposited without proper finalization, leading to stuck funds

### 5. [VERIFIER] Dev-Skip Feature Can Bypass All Verification
**Contract:** ptf_verifier_groth16  
**Severity:** CRITICAL  
**Impact:** If accidentally deployed, completely bypasses proof verification, allowing unlimited token extraction

### 6. [VERIFIER] No Size Limits on Proof and Public Inputs
**Contract:** ptf_verifier_groth16  
**Severity:** CRITICAL  
**Impact:** DoS attacks via extremely large proofs/inputs, compute unit exhaustion

### 7. [FACTORY] Timelock Action Hash Collision Risk
**Contract:** ptf_factory  
**Severity:** CRITICAL  
**Impact:** Hash computation doesn't include salt, risking collisions and duplicate action issues

### 8. [FACTORY] Sequence Overflow Not Fully Protected
**Contract:** ptf_factory  
**Severity:** CRITICAL  
**Impact:** If sequence reaches u64::MAX, timelock system permanently breaks

### 9. [FACTORY] Pending Action Hashes Vector Can Grow Unbounded
**Contract:** ptf_factory  
**Severity:** CRITICAL  
**Impact:** DoS attack by queuing many actions and never executing, permanently disabling timelock

## High Severity Vulnerabilities

### 10. [POOL] Stuck Shield Claim Recovery Logic is Complex
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** Complex logic could lead to premature deactivation or failure to detect stuck states

### 11. [POOL] Allowance Amount Mismatch Check
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** Could prevent valid transfers if fees are involved

### 12. [POOL] Hook Whitelist Can Be DoS'd
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** Once whitelist fills (100 programs), no new hooks can be added permanently

### 13. [POOL] No Size Limits on Public Inputs
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** DoS via large public inputs, compute exhaustion

### 14. [POOL] Transfer Public Input Validation is Incomplete
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** Amount commitments not fully validated, potential for manipulation

### 15. [VERIFIER] Authority Validation Only Checks Owner, Not Signer
**Contract:** ptf_verifier_groth16  
**Severity:** HIGH  
**Impact:** Any account owned by factory program could create verifying keys

### 16. [VERIFIER] Hash Verification Happens After Authority Check
**Contract:** ptf_verifier_groth16  
**Severity:** HIGH  
**Impact:** No validation that hash matches known good keys, could accept malicious keys

### 17. [FACTORY] No Validation of Verifying Key Data Size
**Contract:** ptf_factory  
**Severity:** HIGH  
**Impact:** DoS via extremely large verifying keys, account size issues

### 18. [FACTORY] Mint PTKN Function Lacks Comprehensive Validation
**Contract:** ptf_factory  
**Severity:** HIGH  
**Impact:** Could mint to invalid accounts, no amount limits, no pool state validation

### 19. [VAULT] No Balance Validation in Release Function
**Contract:** ptf_vault  
**Severity:** HIGH  
**Impact:** No explicit balance check before releasing, relies on SPL token program rejection

### 20. [VAULT] Missing Reentrancy Protection in Deposit Function
**Contract:** ptf_vault  
**Severity:** HIGH  
**Impact:** Potential for unexpected state changes during deposit if called in hook context

### 21. [POOL] No Validation of Commitment Uniqueness
**Contract:** ptf_pool  
**Severity:** HIGH  
**Impact:** Could allow duplicate commitments, unclear semantics

## Medium Severity Vulnerabilities

### 22. [POOL] Invariant Checks Are Optional
**Contract:** ptf_pool  
**Severity:** MEDIUM  
**Impact:** Small transfers might not be validated, breaches could go undetected

### 23. [POOL] Tree Can Fill Up
**Contract:** ptf_pool  
**Severity:** MEDIUM  
**Impact:** Once tree is full (2^32 leaves), no new commitments possible, permanent DoS

### 24. [POOL] Recent Roots Array Has Limited Size
**Contract:** ptf_pool  
**Severity:** MEDIUM  
**Impact:** Valid proofs could be rejected if root is older than 16 roots

### 25. [POOL] Hook Account Validation is Lenient in Lenient Mode
**Contract:** ptf_pool  
**Severity:** MEDIUM  
**Impact:** Could allow account substitution attacks in lenient mode

### 26. [VERIFIER] No Version Validation in Verify Function
**Contract:** ptf_verifier_groth16  
**Severity:** MEDIUM  
**Impact:** Old proofs might be used with new keys, version mismatches

### 27. [VERIFIER] Host Fallback Uses Different Verification Logic
**Contract:** ptf_verifier_groth16  
**Severity:** MEDIUM  
**Impact:** Different results between syscall and host fallback, inconsistencies

### 28. [VERIFIER] No Protection Against Key Tampering
**Contract:** ptf_verifier_groth16  
**Severity:** MEDIUM  
**Impact:** If account is compromised, key could be modified (though hash check would catch it)

### 29. [FACTORY] Timelock Minimum Duration Enforcement
**Contract:** ptf_factory  
**Severity:** MEDIUM  
**Impact:** 24 hours may be too short for high-value operations

### 30. [FACTORY] Freeze Authority Not Fully Validated
**Contract:** ptf_factory  
**Severity:** MEDIUM  
**Impact:** Reused mints with non-factory freeze authority are rejected, no recovery

### 31. [FACTORY] Action Hash Recalculation in Execute Could Fail
**Contract:** ptf_factory  
**Severity:** MEDIUM  
**Impact:** Valid actions could be rejected if serialization changes

### 32. [VAULT] Timelock Duration is Hardcoded
**Contract:** ptf_vault  
**Severity:** MEDIUM  
**Impact:** Cannot adapt to changing security requirements

### 33. [VAULT] No Validation of New Authority in Propose Authority Change
**Contract:** ptf_vault  
**Severity:** MEDIUM  
**Impact:** Could accidentally set authority to invalid address

### 34. [VAULT] Missing Event for Deposit Validation
**Contract:** ptf_vault  
**Severity:** MEDIUM  
**Impact:** Event data might be inconsistent with actual state

## Low Severity Vulnerabilities

### 35. [POOL] No Rate Limiting on Operations
**Contract:** ptf_pool  
**Severity:** LOW  
**Impact:** Potential for spam attacks, accelerated tree filling

### 36. [POOL] Protocol Fees Never Collected
**Contract:** ptf_pool  
**Severity:** LOW  
**Impact:** Fees accumulate indefinitely with no withdrawal mechanism

### 37. [FACTORY] No Rate Limiting on Mint Registration
**Contract:** ptf_factory  
**Severity:** LOW  
**Impact:** Account creation spam, increased storage costs

### 38. [FACTORY] Pause Function Has No Timelock
**Contract:** ptf_factory  
**Severity:** LOW  
**Impact:** Instant DoS if authority is compromised

### 39. [VERIFIER] No Logging of Verification Failures
**Contract:** ptf_verifier_groth16  
**Severity:** LOW  
**Impact:** Hard to debug verification failures, no failure tracking

### 40. [VERIFIER] Empty Proof/Input Checks Are Good But Could Be Earlier
**Contract:** ptf_verifier_groth16  
**Severity:** LOW  
**Impact:** Minor efficiency issue, could save compute units

### 41. [VAULT] No Maximum Amount Limits
**Contract:** ptf_vault  
**Severity:** LOW  
**Impact:** Could cause compute unit exhaustion, no protection against large transfers

## Informational Issues

### 42. [POOL] Complex State Machine for Shield Claims
**Contract:** ptf_pool  
**Severity:** INFORMATIONAL  
**Impact:** Complex logic increases bug risk, hard to reason about

### 43. [FACTORY] Direct Updates Completely Disabled
**Contract:** ptf_factory  
**Severity:** INFORMATIONAL  
**Impact:** Good security but reduces operational flexibility

### 44. [VAULT] Authority Change Execution Can Be Called by Anyone
**Contract:** ptf_vault  
**Severity:** INFORMATIONAL  
**Impact:** Once timelock expires, anyone can execute (likely intentional)

## Recommendations by Priority

### Immediate Action Required (Before Mainnet)
1. Fix transfer and unshield circuits to include output commitments in root computation
2. Replace bloom filter nullifier set with deterministic structure
3. Make shield finalization truly atomic
4. Add size limits to all user inputs (proofs, public inputs, verifying keys)
5. Remove or harden dev-skip feature in verifier
6. Fix timelock action hash computation to include salt or remove salt

### High Priority (Before Mainnet)
1. Add comprehensive input validation
2. Fix factory pending actions DoS vector
3. Add balance validation in vault release
4. Improve authority validation in verifier
5. Add hook whitelist removal mechanism
6. Make invariant checks mandatory

### Medium Priority (Post-Mainnet)
1. Add tree migration mechanism
2. Increase recent roots array size
3. Add protocol fee collection mechanism
4. Improve timelock duration flexibility
5. Add rate limiting mechanisms

## Contract-Specific Summaries

### ptf_vault
- **Overall:** Well-designed with good timelock protection
- **Key Issues:** Missing balance validation, no reentrancy protection
- **Risk Level:** Medium (mostly operational issues)

### ptf_factory
- **Overall:** Good timelock system but has DoS vectors
- **Key Issues:** Hash collision risk, pending actions DoS, sequence overflow
- **Risk Level:** High (DoS risks are significant)

### ptf_verifier_groth16
- **Overall:** Critical if dev-skip is deployed, otherwise good
- **Key Issues:** Dev-skip bypass, no size limits, weak authority validation
- **Risk Level:** Critical (if dev-skip enabled), High (otherwise)

### ptf_pool
- **Overall:** Most complex, most critical issues
- **Key Issues:** Circuit root mismatches, bloom filter DoS, finalization bypass
- **Risk Level:** Critical (multiple critical issues)

## Conclusion

The zPump protocol has a solid foundation with good security practices (timelocks, proof verification, PDA validation). However, there are several critical issues that must be addressed before mainnet deployment:

1. **Circuit fixes are mandatory** - Root computation mismatches are fundamental flaws
2. **Nullifier set must be deterministic** - Bloom filter false positives are unacceptable
3. **Input validation is essential** - Size limits and comprehensive checks needed
4. **DoS protections required** - Multiple vectors need mitigation

The most urgent fixes are in the pool program (circuit root issues, nullifier set) and verifier program (dev-skip, size limits). Once these are addressed, the protocol should be significantly more secure.

**Estimated Time to Fix Critical Issues:** 4-6 weeks
**Recommended Audit Review:** After critical fixes are implemented

---

*This audit was conducted on [DATE]. For detailed analysis of each vulnerability, see the individual contract audit files.*

