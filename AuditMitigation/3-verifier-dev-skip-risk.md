# High – `groth16-dev-skip` bypasses verification

- **Impact:** Deploying the verifier with the dev-skip feature causes every `groth16_verify` call to return `true`, so all pool proofs succeed without cryptography.
- **Evidence:** The BPF/SBF implementation behind the `groth16-dev-skip` cfg returns `true` immediately. 【F:programs/verifier-groth16/src/lib.rs†L205-L233】
- **Mitigation Plan:**
  1. Forbid the dev-skip feature in production builds (e.g., add a CI job that rejects artifacts where `cfg(groth16-dev-skip)` is enabled).
  2. Add a runtime assertion inside `initialize_verifying_key` that panics if dev-skip is compiled in on mainnet clusters.
  3. Provide an integration test that fails when `groth16_verify` accepts an invalid proof while the syscall feature is enabled.
