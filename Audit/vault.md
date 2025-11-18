# Vault Program Security Audit

## Medium – Authority change timelock can deadlock the vault forever
* **Location.** `propose_authority_change` always `init`s the `pending_change` PDA at seed `b"pending-auth" || vault_state`, while `execute_authority_change`/`cancel_authority_change` are the only entry points that close it again.【F:programs/vault/src/lib.rs†L89-L200】【F:programs/vault/src/lib.rs†L260-L310】
* **Why it matters.** If a CPI into `propose_authority_change` succeeds but the follow-up execution or cancellation never happens (for example, the pool program crashes mid-flight), the `pending_change` PDA remains allocated and cannot be overwritten. Subsequent governance attempts fail because `init` at the same seed aborts, permanently blocking any future authority rotation.
* **Impact.** Medium operational risk: a single stuck proposal bricks the vault’s upgrade path, which in turn prevents rotating compromised authorities or shipping emergency fixes.
* **Mitigation.** Replace `init` with `init_if_needed` plus strict state validation, or add a “force cancel” instruction that can be executed by governance (e.g., via the factory timelock) after a timeout to close orphaned `pending_change` PDAs.
