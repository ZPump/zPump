# PTF Verifier (Groth16) Audit

## Critical Findings

1. **On-chain verifier always returns `true`**  
   The BPF/SBF build of `groth16_verify` is stubbed to a constant `true`, so every proof passes:

```194:199:programs/verifier-groth16/src/lib.rs
#[cfg(any(target_arch = "bpf", target_arch = "sbf"))]
fn groth16_verify(_verifying_key: &[u8], _proof: &[u8], _public_inputs: &[u8]) -> bool {
    true
}
```
   Because `ptf_pool` relies on this CPI to gate shield/unshield, an attacker can submit arbitrary proofs and drain all vault funds without possessing valid witnesses. **Recommendation:** call the Solana Groth16 syscall (`groth16_verify_syscall`) on-chain, keep the Arkworks fallback strictly for off-chain tests, and add integration tests that fail when the BPF build doesn’t link the syscall.

## Medium Findings

1. **No linkage between stored hash and execution**  
   `verify_groth16` checks `verify_account_hash(vk)` but still proceeds even when `vk.verifying_key` is empty (because the check only verifies the digest of the empty vector). While `initialize_verifying_key` rejects empty vectors, a subsequent governance bug could zero out the vector and still satisfy the hash check. **Recommendation:** explicitly reject empty verifying keys inside `verify_groth16` as well.

## Operational Improvements

- The verifier stores the entire verifying key blob in a single account; consider chunking into multiple PDAs to stay below Solana’s 10 MB per-account ceiling and lower CPI read costs.
- Emit the total byte length of the verifying key in the `VerifyingKeyRegistered` event so downstream tooling can sanity-check uploads.
