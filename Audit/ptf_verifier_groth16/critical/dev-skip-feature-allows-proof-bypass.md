# Dev-skip Build Flag Disables On-chain Proof Verification

**Status:** ⚠️ NEW ISSUE

**Severity:** CRITICAL

**Location:** `programs/verifier-groth16/src/lib.rs:814-824` (groth16_verify)

## Description

The verifier program includes a `groth16-dev-skip` feature gate that replaces the `groth16_verify` routine with an implementation that **unconditionally returns `true`** on BPF/SBF targets. The only guard is a log warning; there is no runtime or compile-time prevention against deploying the dev-skip build to production clusters. If the verifier program is built with `--features groth16-dev-skip` (intended for local development), every proof will be accepted without cryptographic verification.

## Code Reference

### groth16_verify (line 814-824):
```rust
#[cfg(all(
    feature = "groth16-dev-skip",
    not(feature = "groth16-syscall"),
    any(target_arch = "bpf", target_arch = "sbf")
))]
fn groth16_verify(_verifying_key: &[u8], _proof: &[u8], _public_inputs: &[u8]) -> bool {
    // WARNING: This bypasses proof verification - only use for local development!
    // For production, build with --features groth16-syscall instead
    true
}
```

## Issue

A production deployment built with the `groth16-dev-skip` feature will silently bypass zero-knowledge proof verification. The program emits only a runtime warning and still processes transactions. Attackers can submit arbitrary proofs to mint, transfer, or unshield funds without satisfying any circuit constraints, leading to complete loss of integrity for shielded balances.

## Impact

- **Attack scenario:** Deploy verifier with `groth16-dev-skip` enabled (e.g., due to CI misconfiguration). Attackers submit arbitrary proofs that are automatically accepted.
- **Potential loss:** Unlimited unauthorized shield/unshield/transfer actions; total loss of funds and system integrity.
- **Likelihood:** Medium—feature can be accidentally enabled during build, and no on-chain safeguard prevents production use.

## Attack Scenario

1. Deployer builds the verifier with `--features groth16-dev-skip` (intentionally or by mistake) and deploys it to production.
2. Because `groth16_verify` always returns `true`, any submitted proof passes verification.
3. An attacker crafts arbitrary transactions (shield/unshield/private transfer) with bogus proofs and steals funds or corrupts state.

## Current Mitigations

- Only a log warning is emitted in `initialize_verifying_key` when `groth16-dev-skip` is compiled in. No enforcement exists.

## Recommendation

Add hard enforcement to prevent production deployment with dev-skip:
- Gate `initialize_verifying_key` and `verify_groth16` to **fail** when `groth16-dev-skip` is enabled on-chain.
- Prefer compile-time guards that error for BPF builds when `groth16-dev-skip` is set without an explicit `allow_dev_skip` flag.

### Suggested Fix:
```rust
#[cfg(all(feature = "groth16-dev-skip", any(target_arch = "bpf", target_arch = "sbf")))]
fn groth16_verify(_verifying_key: &[u8], _proof: &[u8], _public_inputs: &[u8]) -> bool {
    // Fail fast on-chain to prevent accidental production deployment
    msg!("FATAL: groth16-dev-skip build deployed; rejecting verification");
    return false;
}
```

## Related Code

- `programs/verifier-groth16/src/lib.rs:200-304` - `verify_groth16` calls `groth16_verify` without enforcing production-only syscall builds.
- `programs/verifier-groth16/src/lib.rs:420-439` - `initialize_verifier_config` logs a warning but does not forbid dev-skip builds.
