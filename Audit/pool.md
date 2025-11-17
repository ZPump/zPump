# Pool Program Audit

## Critical: Private transfers append attacker-chosen commitments that are never bound to the ZK proof
- **Where:** `execute_private_transfer` never inspects `args.public_inputs` to ensure the output commitments and amount commitments passed in the instruction actually match what the Groth16 circuit proved. The implementation simply appends whatever arrays the caller supplied and trusts the resulting Merkle root. 【F:programs/pool/src/lib.rs†L1004-L1112】
- **Issue:** Because the transfer circuit’s public statement only constrains the old root and nullifiers (see the in-line TODO comment), the program never checks that the commitments being inserted were part of the proof or that their amounts conserve value. A malicious spender can submit a valid proof for *any* prior nullifiers but simultaneously append arbitrarily forged output commitments/amounts, effectively minting new shielded notes without proving that they balance the inputs.
- **Impact:** This completely breaks the soundness of shielded transfers: the Merkle tree can be polluted with fraudulent commitments that represent arbitrary value, allowing attackers to inflate the private supply or double-spend notes. Downstream proofs that consume those forged notes will verify because the tree really contains them.
- **Mitigation:** Make the Groth16 circuit output (and the on-chain code verify) the full set of output commitments, output amount commitments, and the resulting new root. The program should reject any instruction whose calldata does not exactly match those public inputs.

## Critical: `transfer_from` only subtracts the user-supplied `allowance_amount`
- **Where:** The allowance bookkeeping reduces `allowance.amount` by `args.allowance_amount` without checking that it matches the actual spend described by `args.transfer`. 【F:programs/pool/src/lib.rs†L952-L999】
- **Issue:** A malicious spender can set `allowance_amount = 1` while submitting a zero-knowledge proof that spends an arbitrarily large value. The proof succeeds, the vault releases funds, and only “1” is deducted from the allowance, letting the attacker drain the owner’s entire balance while barely decreasing the allowance.
- **Impact:** Any approved delegate can steal *all* shielded assets authorized to them with a single call, violating the expected cap on delegated spending and enabling full account takeover through allowance abuse.
- **Mitigation:** Parse the transfer’s public inputs to recover the amount being spent and require `allowance_amount == transfer_amount`. Alternatively, drop the redundant field and always decrement by the actual spend computed from the proof.

## Additional Observations
- The `transfer` circuit comment notes that the Groth16 `new_root` currently ignores output commitments. Fixing the circuit as part of the first finding will also eliminate this discrepancy.
