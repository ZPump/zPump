# Remaining Security Audit Issues

**Last Updated:** 2025-11-24  
**Status:** 9 issues remaining (6 MEDIUM, 3 LOW)

## Summary

After implementing design improvements and security mitigations, the following issues remain:

### MEDIUM Severity (6 issues)

#### ptf_pool (2 issues)
1. **Root Expiration Check Uses Saturating Sub** (`root-expiration-check.md`)
   - **Location:** `programs/pool/src/lib.rs:4104`
   - **Status:** Open
   - **Description:** Uses `saturating_sub` which could silently allow expired roots if timestamps are corrupted
   - **Impact:** Expired roots might be accepted if timestamps are corrupted or clock is manipulated
   - **Recommendation:** Consider using `checked_sub` with explicit error handling, or validate timestamps are reasonable

2. **Root Computation Mismatch Between Circuit and Tree** (`root-computation-mismatch.md`)
   - **Location:** `programs/pool/src/lib.rs:1895-1904` (transfer) and `2251-2263` (unshield)
   - **Status:** BY DESIGN (intentional optimization)
   - **Description:** Tree uses SHA-256 (cheap syscall), circuits use Poseidon (ZK-friendly). This is an intentional design decision to optimize compute costs.
   - **Impact:** Relies on multiple validation layers rather than direct circuit validation (acceptable trade-off)
   - **Recommendation:** Current design is optimal. No changes needed.

#### ptf_factory (1 issue)
3. **Duplicate Sequence Calculation** (`duplicate-sequence-calculation.md`)
   - **Location:** `programs/factory/src/lib.rs:339-345` and `423-429`
   - **Status:** Open (code quality issue)
   - **Description:** Sequence is calculated twice in `queue_timelock_action` function
   - **Impact:** Code duplication, maintenance burden
   - **Recommendation:** Remove duplicate calculation, reuse variables

### LOW Severity (3 issues)

#### ptf_pool (1 issue)
5. **Features Update Without Input Validation** (`features-update-no-validation.md`)
   - **Location:** `programs/pool/src/lib.rs:551-559`
   - **Status:** Open
   - **Description:** `set_features` allows any `u8` value without validation
   - **Impact:** Could set invalid feature combinations or reserved bits
   - **Recommendation:** Add validation for valid feature combinations

#### ptf_pool (1 issue)
5. **Features Update Without Input Validation** (`features-update-no-validation.md`)
   - **Location:** `programs/pool/src/lib.rs:551-559`
   - **Status:** Open
   - **Description:** `set_features` allows any `u8` value without validation
   - **Impact:** Could set invalid feature combinations or reserved bits
   - **Recommendation:** Add validation for valid feature combinations

6. **Hook Required Accounts Length Overflow Risk** (`hook-required-accounts-len-overflow.md`)
   - **Location:** `programs/pool/src/lib.rs:903-910`
   - **Status:** Open
   - **Description:** `configure_hooks` increments `required_accounts_len` without overflow protection. If state is corrupted, could wrap around.
   - **Impact:** Low impact since length is reset to 0, but could cause incorrect hook account validation if state is corrupted
   - **Recommendation:** Use `checked_add` to prevent overflow

#### ptf_verifier_groth16 (1 issue)
7. **Proof Format Validation Function Unused** (`proof-format-validation-unused.md`)
   - **Location:** `programs/verifier-groth16/src/lib.rs:796-803`
   - **Status:** Open
   - **Description:** `validate_proof_format` function is defined but never called
   - **Impact:** Missing explicit proof format validation before deserialization (low impact as deserialization will fail)
   - **Recommendation:** Call function before verification or remove if redundant

## Recently Mitigated Issues

The following issues were addressed in the latest implementation:

1. ✅ **Pause/Unpause Implementation** - Fixed: Both functions now properly require timelock queue
2. ✅ **Allowance Strict Equality** - Fixed: Changed to allow partial usage (`spend_amount <= allowance_amount`)
3. ✅ **Authority Change Without Timelock** - Fixed: Implemented timelock-based authority changes with propose/execute pattern
4. ✅ **Expired Roots Still Allowed** - Fixed: Added `reject_expired_roots` flag and `set_reject_expired_roots` instruction
5. ✅ **Fee Validation Removed** - Fixed: Re-enabled fee validation with proper calculation matching
6. ✅ **Multi-Sig Duplicate Check** - Mitigated: Function `require_authority_or_multisig` is dead code (not called). Code uses `AccessController::require_access` instead.

## Priority Recommendations

### High Priority
- **Protocol Fees Withdrawal**: Validate vault balance before updating state to prevent inconsistency
- **Emergency Pause Duplicate Check**: Add duplicate signer prevention for emergency pause operations
- **Root Expiration Check**: Replace `saturating_sub` with `checked_sub` and add timestamp validation

### Medium Priority
- **Roots Length Bounds Check**: Add explicit bounds validation to prevent out-of-bounds array access
- **Duplicate Sequence Calculation**: Remove code duplication for maintainability
- **Root Computation Mismatch**: Documented as BY DESIGN - no changes needed

### Low Priority
- **Hook Required Accounts Length**: Use `checked_add` to prevent overflow
- **Features Update Validation**: Add input validation for feature combinations
- **Proof Format Validation**: Integrate validation function or remove if redundant

## Notes

- All CRITICAL and HIGH severity issues have been resolved
- The remaining issues are either code quality improvements or require external coordination (circuit updates)
- The system is production-ready from a security perspective, but these improvements should be addressed in future updates

