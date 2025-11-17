# High – Timelock entries cannot be executed

- **Impact:** Because execution looks for a different PDA than the account that `queue_timelock_action` created, no queued governance action can ever execute or close. That freezes mint configuration changes, fee updates, and pause/unpause forever.
- **Evidence:** Queue derives `["timelock", factory_state, salt]` whereas execution/cancel expect `["timelock", factory_state, sequence]`. 【F:programs/factory/src/lib.rs†L613-L652】
- **Mitigation Plan:**
  1. Pick a single canonical seed tuple (sequence-based is preferred) and use it consistently when initializing, executing, and cancelling timelock entries.
  2. Migrate any previously queued actions by replaying them at the new PDA or provide an off-chain script to cancel/requeue with the corrected seeds.
  3. Add an integration test that queues an action and executes it successfully to prevent regressions.
