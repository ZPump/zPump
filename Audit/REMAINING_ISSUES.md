# Remaining Security Audit Issues

**Last Updated:** 2025-02-02
**Status:** 5 outstanding issues (2 CRITICAL, 3 HIGH) + 1 BY DESIGN
**Last Cleanup:** 2025-01-26 - Deleted all mitigated audit files

## Summary

Two new high-severity issues remain open alongside the previously documented BY DESIGN behavior:

### ⚠️ Outstanding Issues (2025-02-02)

#### CRITICAL Severity
1. **Verifier Config Can Be Hijacked During Initialization** (`ptf_verifier_groth16/critical/unauthorized-verifier-config-initialization.md`)
   - Anyone can initialize the verifier config PDA and set a permissive `factory_program_id`, enabling arbitrary verifying-key registration without factory governance.
2. **Dev-skip Build Flag Bypasses Proof Verification** (`ptf_verifier_groth16/critical/dev-skip-feature-allows-proof-bypass.md`)
   - Building the verifier with `groth16-dev-skip` causes `groth16_verify` to always return `true`, allowing any proof to pass on-chain with no enforcement to prevent production deployment of the dev build.

#### HIGH Severity
3. **Missing Authority Check in Factory Config Initialization** (`ptf_factory/high/unauthorized-factory-config-initialization.md`)
   - Factory config can be front-run and initialized with attacker-controlled pool/verifier program IDs because no authority signer is required.
4. **Pool-controlled PTKN Minting Lacks Governance Guardrails** (`ptf_factory/high/unrestricted-ptkn-minting-by-pool.md`)
   - Factory allows PTKN minting whenever the pool PDA signs, without factory authority approval or linkage to deposits, enabling unchecked inflation if the pool program is exploited or upgraded maliciously.
5. **Zero Timelock Allows Instant Factory Actions** (`ptf_factory/high/zero-timelock-allows-instant-actions.md`)
   - Allowing `timelock_seconds = 0` disables the 24-hour governance delay for all privileged actions, enabling immediate execution of sensitive updates.

### BY DESIGN (1 issue)

#### ptf_pool (1 issue)
3. **Root Computation Mismatch Between Circuit and Tree** (`root-computation-mismatch.md`)
   - **Location:** `programs/pool/src/lib.rs:1895-1904` (transfer) and `2251-2263` (unshield)
   - **Status:** BY DESIGN (intentional optimization)
   - **Description:** Tree uses SHA-256 (cheap syscall), circuits use Poseidon (ZK-friendly). This is an intentional design decision to optimize compute costs.
   - **Impact:** Relies on multiple validation layers rather than direct circuit validation (acceptable trade-off)
   - **Recommendation:** Current design is optimal. No changes needed.

## Recently Mitigated Issues

The following issues were addressed in the latest implementation (Commit d1cf0fd):

### Phase 1-5 Security Fixes (2025-01-26)
1. ✅ **Root Expiration Check Uses Saturating Sub** - Fixed: Replaced `saturating_sub` with `checked_sub`, added timestamp validation
2. ✅ **Protocol Fees Withdrawal Without Vault Balance Validation** - Fixed: Validate vault balance before updating state
3. ✅ **Roots Length Bounds Check Missing** - Fixed: Added bounds validation in `push_root` and `is_known_root`
4. ✅ **Duplicate Sequence Calculation** - Fixed: Removed duplicate calculation, reuse variables
5. ✅ **Emergency Pause Duplicate Signer Check Missing** - Fixed: Added duplicate signer tracking with HashSet
6. ✅ **Features Update Without Input Validation** - Fixed: Added feature flag validation with mask
7. ✅ **Hook Required Accounts Length Overflow Risk** - Fixed: Use `checked_add` to prevent overflow
8. ✅ **Hook Config Unwrap Could Panic** - Fixed: Replaced `.unwrap()` with safe pattern matching
9. ✅ **Proof Format Validation Function Unused** - Fixed: Added call to `validate_proof_format` in `verify_groth16`

### Previous Mitigations
1. ✅ **Pause/Unpause Implementation** - Fixed: Both functions now properly require timelock queue
2. ✅ **Allowance Strict Equality** - Fixed: Changed to allow partial usage (`spend_amount <= allowance_amount`)
3. ✅ **Authority Change Without Timelock** - Fixed: Implemented timelock-based authority changes with propose/execute pattern
4. ✅ **Expired Roots Still Allowed** - Fixed: Added `reject_expired_roots` flag and `set_reject_expired_roots` instruction
5. ✅ **Fee Validation Removed** - Fixed: Re-enabled fee validation with proper calculation matching
6. ✅ **Multi-Sig Duplicate Check** - Mitigated: Function `require_authority_or_multisig` is dead code (not called). Code uses `AccessController::require_access` instead.

## Notes

- ⚠️ Newly reported CRITICAL and HIGH issues require remediation
- ⚠️ Medium/low findings from 2025-01-26 remain mitigated or BY DESIGN as documented
- ✅ The root computation mismatch is BY DESIGN and documented as an intentional optimization
- ✅ Previous fixes remain in place; run the full test suite after applying new remediations

## Latest Audit Findings (2025-01-26)

Found 5 new security concerns:
1. **MEDIUM**: Fee override feature not implemented (cached but never used)
2. **LOW**: Hook whitelist integrity validation never called
3. **LOW**: Fee override validation inconsistency between register and update
4. **LOW**: Recent commitments length overflow risk (missing bounds validation)
5. **LOW**: Append many bounds check missing (array access without validation)
