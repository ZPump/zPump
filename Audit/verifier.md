# Verifier Program Security Audit

## Critical – `groth16-dev-skip` completely bypasses proof verification
* **Location.** When the `groth16-dev-skip` feature is enabled, the on-chain `groth16_verify` helper unconditionally returns `true`, yet `verify_groth16` only emits a warning and proceeds.【F:programs/verifier-groth16/src/lib.rs†L87-L119】【F:programs/verifier-groth16/src/lib.rs†L243-L254】
* **Why it matters.** If the production build accidentally keeps the dev feature flag, every proof verification succeeds no matter what bytes are supplied. Attackers can then mint arbitrary notes, unshield without secrets, or replay old transactions.
* **Impact.** Critical integrity failure across the entire protocol whenever a misconfigured deployment uses the wrong build flags.
* **Mitigation.** Remove the dev-skip feature from production entirely or add a runtime gate (e.g., check the cluster ID via `solana_program::sysvar::slot_history`) that panics if dev-skip is set outside of localnet.

## Medium – Verifying key accounts can be arbitrarily large
* **Location.** `initialize_verifying_key` accepts an unbounded `verifying_key_data: Vec<u8>` and allocates an account whose size equals that length without enforcing any upper limit.【F:programs/verifier-groth16/src/lib.rs†L21-L85】【F:programs/verifier-groth16/src/lib.rs†L150-L190】
* **Why it matters.** A malicious authority can create a verifying key that is hundreds of megabytes long, forcing the payer (often the factory PDA) to lock enormous rent deposits and possibly making the transaction exceed the Solana account size cap, leading to persistent DoS conditions.
* **Impact.** Medium risk of governance-level griefing and resource exhaustion whenever the authority key is compromised or misused.
* **Mitigation.** Enforce a strict maximum verifying key size that matches the circuit tooling (e.g., <100 KB) and reject any attempt to exceed it before allocating the account.
