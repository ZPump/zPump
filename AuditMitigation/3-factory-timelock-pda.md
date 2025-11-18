# 3. Factory: Timelock PDA mismatch (High)

**Summary.** `queue_timelock_action` increments the action sequence after Anchor has already derived the `timelock_entry` PDA, so the stored `entry.sequence` never matches the PDA seeds required by `execute_timelock_action`/`cancel_timelock_action`.

**Mitigation plan.**
1. Pre-compute the next sequence in the accounts context. For example, pass the expected sequence as an instruction argument and derive the PDA with `[seeds::TIMELOCK, factory_state.key().as_ref(), &next_sequence.to_le_bytes()]` while the handler writes `entry.sequence = next_sequence`.
2. Alternatively, stop incrementing before account creation: mutate and save `factory_state.last_action_sequence` inside a separate instruction or via a pre-instruction so that Anchor sees the incremented value when deriving the PDA.
3. Add tests that queue an action, execute it, and assert the PDA constraints succeed to ensure the seeds stay aligned going forward.
