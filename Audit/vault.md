# Vault Program Audit

The vault contract is intentionally small: it only supports deposits from users, releases authorized by the pool PDA, and a timelocked authority rotation (`propose_authority_change`/`execute_authority_change`). Review highlights:

- Authority-gated flows are guarded by `validate_pool_authority`, which verifies the PDA signer, owner, and stored authority field before letting the vault transfer funds. 【F:programs/vault/src/lib.rs†L52-L86】【F:programs/vault/src/lib.rs†L388-L399】
- Authority rotation now goes through a 7-day timelock and stores pending changes in a dedicated PDA so unauthorized parties cannot instantly seize the vault. 【F:programs/vault/src/lib.rs†L90-L202】【F:programs/vault/src/lib.rs†L250-L333】

No exploitable vulnerabilities were identified in this program during the review. The residual risk is governance-related: if the current pool authority is compromised it can still propose a malicious rotation and, after the timelock, permanently take the vault. Mitigate that risk at the operational layer (e.g., multi-sig authorities and monitoring for unexpected `AuthorityChangeProposed` events).
