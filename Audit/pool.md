# Pool Program Security Audit

## 1. Nullifiers are never recorded during unshield (Critical)
**Finding.** The `process_unshield` flow never touches the `nullifier_set` account that is supplied in the `Unshield` context. The helper `process_nullifiers` exists but is never invoked, and the unshield handler only updates the ledger, commitment tree, and vault release logic (lines 1190-1450) without a single call to `nullifier_set.insert`. Because of this, the same nullifier can be reused indefinitely for unshield operations.

**Impact.** Attackers can replay any proven spend and drain the vault repeatedly. Once a proof is generated for a set of notes, the lack of nullifier tracking lets the attacker submit the exact same unshield transaction over and over, doubling or infinitely multiplying the withdrawal. This completely breaks the one-time-spend guarantee of the privacy pool.

**Mitigation.** Mirror the `execute_private_transfer` logic: load the `nullifier_set` via `ctx.accounts.nullifier_set`, insert every `args.nullifier`, and reject duplicates. The unused `process_nullifiers` helper (lines 1174-1187) can be wired in to avoid duplication.

## 2. Allowance limits are unenforceable (High)
**Finding.** `transfer_from` attempts to honor an allowance by requiring `allowance_amount == spend_amount` and subtracting that value from the stored allowance (lines 930-991). However, both `allowance_amount` and `spend_amount` are arbitrary user inputs, and there is no linkage between those fields and the actual value spent inside `args.transfer`. The SNARK proof does not expose the spend amount publicly, so an attacker can set both values to a minimal number (e.g., 1) while the concealed transfer actually spends thousands of tokens.

**Impact.** Once a user approves *any* allowance, the spender can drain unlimited value by repeatedly submitting `transfer_from` calls that decrement the allowance by a negligible amount while secretly moving much larger balances. This makes allowance-based controls meaningless and exposes shielded users to loss.

**Mitigation.** Derive the actual spend amount from verifiable public inputs inside the transfer proof (e.g., include the sum of outputs destined for the spender) and compare that derived value against the allowance before calling `execute_private_transfer`. At minimum, reject transfers whose claimed `spend_amount` does not match the value encoded in the public inputs.
