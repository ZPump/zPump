# Verifier Program Security Audit

## 1. `groth16-dev-skip` fully disables proof verification (Critical)
**Finding.** When the `groth16-dev-skip` feature is enabled, the on-chain verifier short-circuits every proof by returning `true` (lines 235-254) and only logs a warning inside `initialize_verifying_key`/`verify_groth16` (lines 29-104). There is no runtime guard that prevents deploying a build compiled with this flag, so a misconfigured release silently accepts any fake proof.

**Impact.** If the production build accidentally includes `groth16-dev-skip`, every shield, unshield, and transfer proof passes without cryptographic validation, enabling unlimited forgery of balances and draining of all pools. The warning log is insufficient because it does not fail the transaction.

**Mitigation.** Fail fast whenever `groth16-dev-skip` is active on a non-development cluster: panic inside `initialize_verifying_key` or `verify_groth16`, or add an explicit runtime check that requires the `groth16-syscall` feature when `cfg!(target_os = "solana")`. Release pipelines should also enforce the correct feature set.
