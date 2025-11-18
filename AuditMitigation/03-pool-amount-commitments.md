# 3. Pool – Output amount commitments are unchecked

* **Problem.** `validate_transfer_public_inputs` admits that `output_amount_commitments` are not part of the proof’s public inputs, so the program cannot confirm that the ciphertexts match the circuit witness.【F:programs/pool/src/lib.rs†L3337-L3372】
* **Exploitation path.** Produce a valid proof for spending some notes but submit fake amount commitments that encode much larger values. The note ledger will record the forged commitments and future unshields will leak real assets.
* **Mitigations.**
  1. Update the circuit so each amount commitment is either emitted as a public input or can be recomputed from other public data.
  2. Once exposed, enforce equality on-chain before appending the leaves.
  3. If circuit work is not immediately possible, disable any feature (transfers, allowances, hooks, invariants) that relies on trusting `output_amount_commitments`.
