# Critical – Private transfers accept forged commitments

- **Impact:** Attackers can append arbitrary commitments/amount commits to the Merkle tree while providing a proof that only attests to old roots/nullifiers. This lets them mint unbacked notes or tamper with supply.
- **Evidence:** `execute_private_transfer` never validates that `args.output_commitments`/`args.output_amount_commitments` appear in the proof’s public inputs and simply appends whatever the caller supplied. 【F:programs/pool/src/lib.rs†L1004-L1112】
- **Mitigation Plan:**
  1. Update the Groth16 circuit so the public inputs include every output commitment, every output amount commitment, and the final `new_root`.
  2. On-chain, deserialize those public inputs (similar to `validate_unshield_public_inputs`) and reject the instruction if any field differs from the caller-provided arrays.
  3. Add regression tests that fail whenever the contract accepts outputs that are not part of the proof.
