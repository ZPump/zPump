# Critical – Allowance spend is decoupled from transfer amount

- **Impact:** Approved spenders can drain unlimited funds while decrementing their allowance by only the arbitrary `allowance_amount` they pass in.
- **Evidence:** `transfer_from` subtracts `args.allowance_amount` from storage but never checks that it matches the amount encoded inside `args.transfer`. 【F:programs/pool/src/lib.rs†L952-L999】
- **Mitigation Plan:**
  1. Parse the Groth16 public inputs (or the `TransferArgs`) to recover the actual spend amount.
  2. Enforce `allowance_amount == spend_amount` (or eliminate `allowance_amount` entirely and always deduct the real spend).
  3. Emit auditing events with both the allowance delta and the proof-validated spend so monitors can detect anomalies.
