# 2. Verifier – `groth16-dev-skip` bypass

* **Problem.** When the `groth16-dev-skip` feature is compiled in, `groth16_verify` simply returns `true`, yet `verify_groth16` does not prevent the instruction from succeeding on production networks.【F:programs/verifier-groth16/src/lib.rs†L87-L119】【F:programs/verifier-groth16/src/lib.rs†L243-L254】 Any proof becomes valid.
* **Exploitation path.** Ship a mainnet build that accidentally includes `--features groth16-dev-skip`. Attackers can then submit arbitrary proofs (or none at all) and the verifier will still emit `ProofVerified`, allowing unlimited minting/unshielding.
* **Mitigations.**
  1. Remove the dev-skip feature from production crates and enforce this in CI (e.g., fail builds where `cfg!(feature = "groth16-dev-skip")`).
  2. Add a runtime `require!(!cfg!(feature = "groth16-dev-skip"))` guard that panics unless the program detects it is running on a local cluster.
  3. Publish reproducible build artefacts or attestation scripts so deployers cannot unknowingly push a dev-only binary.
