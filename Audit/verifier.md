# Verifier Program Audit

## High: `groth16-dev-skip` completely bypasses proof verification when enabled
- **Where:** The verifier exposes a `groth16-dev-skip` feature flag that simply returns `true` for every `groth16_verify` invocation on BPF/SBF targets. 【F:programs/verifier-groth16/src/lib.rs†L205-L233】
- **Issue:** Building or deploying the verifier with that feature (intended for local development) means *all* zero-knowledge proofs succeed without cryptographic validation. Any attacker could forge shields, transfers, or unshields because the pool program trusts the verifier CPI.
- **Impact:** Full loss of privacy-pool soundness. Attackers can mint unbacked notes or withdraw arbitrary amounts if the production cluster accidentally runs a `groth16-dev-skip` build.
- **Mitigation:** Lock production releases to the `groth16-syscall` feature in CI/CD, reject binaries that contain the dev-skip symbol, and add a runtime assert that aborts when `groth16-dev-skip` is enabled on mainnet.

## Additional Observations
- `initialize_verifying_key` enforces that only the factory PDA (or another account owned by the factory program) can provision verifying keys, which is the correct trust anchor for the pool.
