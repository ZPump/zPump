# Factory Program Audit

## High: Timelock entries cannot be executed
- **Where:** `QueueTimelockAction` derives each entry PDA with seeds `["timelock", factory_state, salt]` while `ExecuteTimelockAction` expects the same account to live at `["timelock", factory_state, sequence]`. 【F:programs/factory/src/lib.rs†L613-L652】
- **Issue:** Every queued entry is created at the salt-based address, but the executor looks for a sequence-based PDA. As a result, no queued action can satisfy the `seeds` constraint inside `ExecuteTimelockAction`, so every attempt to execute (or close) a queued action will fail validation.
- **Impact:** The factory authority cannot execute *any* change that must go through the timelock (mint updates, feature updates, pause/unpause). Governance is permanently bricked and all downstream pools inherit stale configuration, which is a system-wide denial of service.
- **Mitigation:** Make both queue and execute/cancel derive the PDA from the same seed tuple. The straightforward fix is to re-derive the entry PDA with the monotonically increasing `sequence` both when the account is created and when it is later executed/cancelled.

## Additional Observations
- Pending action hashes are bounded by `FactoryState::MAX_PENDING_ACTIONS`, but an attacker could still force the authority to manually prune abandoned entries. Consider automatically evicting the oldest hash when the vector reaches capacity.
