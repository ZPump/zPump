# Factory Program Security Audit

## High – PTKN mints can retain a hostile freeze authority
* **Location.** When reusing an existing PTKN mint, `prepare_ptkn_mint` only reassigns the `MintTokens` authority if it is not already the factory PDA; it never inspects or revokes the `FreezeAccount` authority on that mint.【F:programs/factory/src/lib.rs†L845-L903】
* **Why it matters.** An integrator can hand the factory a mint whose freeze authority points to an attacker-controlled key. After the mapping is registered the attacker can freeze any PTKN account or permanently freeze the mint, halting withdrawals or burning liquidity at will.
* **Impact.** High risk of denial of service for every PTKN derived from that mapping and, if freeze authority also controls thaw/burn, the attacker could seize user balances.
* **Mitigation.** Reject reused mints unless both the mint and freeze authorities are set to the factory PDA (or set to `None`). For safety, always reassign **all** authorities (`MintTokens`, `FreezeAccount`, `CloseAccount`) before the mapping becomes active.

## Medium – Timelock deduplication can deadlock configuration changes
* **Location.** Every queued action appends its hash to `FactoryState::pending_action_hashes` and the hash is removed only inside `execute_timelock_action`/`cancel_timelock_action`.【F:programs/factory/src/lib.rs†L238-L299】【F:programs/factory/src/lib.rs†L455-L476】
* **Why it matters.** If the PDA that stores a queued action is lost (account closed out-of-band, rent sweep, etc.) there is no instruction that can clean up the stale hash. Because deduplication forbids scheduling another action with the same payload, governance can get permanently stuck and be unable to update critical parameters.
* **Impact.** Medium operational risk: governance actions such as fee changes or mint updates can be blocked indefinitely once a single entry is orphaned.
* **Mitigation.** Track pending hashes in a bounded PDA per entry (so the hash disappears when the PDA is closed) or add an explicit “force prune” instruction that can only be executed after the original PDA has expired and that removes stale hashes from `pending_action_hashes`.
