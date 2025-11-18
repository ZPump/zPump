# 4. Pool – Allowance spending uses attacker-provided amounts

* **Problem.** `transfer_from` only enforces `allowance_amount == spend_amount` but never recomputes the real spend encoded in `TransferArgs`. Those values are not even part of the proof, so the spender can lie about how much they transferred.【F:programs/pool/src/lib.rs†L952-L980】【F:programs/pool/src/lib.rs†L2267-L2281】
* **Exploitation path.** Alice approves Bob to spend 1 PTKN. Bob submits a proof that transfers 1,000 PTKN to himself, but sets `spend_amount = allowance_amount = 1`. The contract decrements the allowance by one unit while Bob steals Alice’s entire balance.
* **Mitigations.**
  1. Remove `transfer_from` until the circuit emits the actual spend amount as a public input.
  2. Alternatively, require the proof to include a public field for “external spend amount” and compare it with the allowance before mutating the allowance account.
  3. Emit stronger monitoring events and disable hooks that rely on allowances until the above is addressed.
