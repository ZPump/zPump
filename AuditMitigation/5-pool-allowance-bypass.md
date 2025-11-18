# 5. Pool: Allowance spend bypass (High)

**Summary.** `transfer_from` trusts the caller-supplied `allowance_amount`/`spend_amount` fields and never derives the actual spend from the proof, so an approved spender can drain arbitrarily large values while only decrementing the allowance by a token or two.

**Mitigation plan.**
1. Extend the transfer circuit and its public inputs to reveal (or commit to) the amount that is being spent on behalf of the allowance owner. A simple approach is to require the spender to include a public delta equal to the value exiting the owner’s notes.
2. In `transfer_from`, recompute that spend amount from the public inputs and compare it to the requested `allowance_amount`, rejecting any mismatch before calling `execute_private_transfer`.
3. Update the SDK so that wallets fill in the allowance fields using the derived spend value, and add regression tests proving that an oversized transfer is rejected even when `allowance_amount` is small.
