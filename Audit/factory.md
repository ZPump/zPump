# Factory Program Security Audit

## 1. Timelock entries derive the wrong PDA (High)
**Finding.** The `queue_timelock_action` handler increments `factory_state.last_action_sequence` *after* Anchor has already derived and created the `timelock_entry` PDA using the pre-increment value. The handler then saves the incremented value into `entry.sequence` (lines 223-291), while the account constraint for subsequent instructions derives the PDA from `timelock_entry.sequence` (lines 637-652). Because the account was created with the prior sequence, the PDA constraint can never be satisfied when executing or canceling the timelocked action.

**Impact.** Every queued timelock action becomes permanently unexecutable and uncancelable, effectively bricking governance changes and freezing the factory in its current configuration. This is a denial-of-service at the governance layer.

**Mitigation.** Derive the `timelock_entry` PDA with the sequence value that will be written to the account. A simple fix is to increment `last_action_sequence` *before* Anchor runs the account constraints (e.g., store the next sequence in a separate instruction argument, or mutate and persist the state via a pre-instruction). Alternatively, keep `entry.sequence` equal to the previous value so the PDA seeds remain aligned.

## 2. Mint freezes do not stop PTKN issuance (High)
**Finding.** Emergency freezes (`freeze_mapping`) only flip the `MintMapping.status` byte (lines 185-200), and every pool-side entry point calls `ensure_mint_active` before proceeding. However, the factory's `mint_ptkn` instruction never checks this status (lines 489-520). As a result, a pool can keep minting PTKN twins via CPI even while governance believes the mint is frozen.

**Impact.** During an incident, governance can freeze a compromised mint mapping expecting all flows to stop, yet a malicious or compromised pool can continue minting arbitrary PTKN supply via the factory CPI. This undermines the entire freeze control, enabling inflation, fee theft, or continued exploitation.

**Mitigation.** Add a status check at the start of `mint_ptkn`, reusing the same `ensure_mint_active` logic used elsewhere, so frozen mappings prevent further PTKN issuance until thawed.
