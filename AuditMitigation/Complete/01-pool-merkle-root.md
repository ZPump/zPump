# 1. Pool – Merkle root not bound to zk proof

* **Problem.** `execute_private_transfer` and `process_unshield` ignore the `new_root` provided by the Groth16 proof and instead trust the caller-supplied leaves when recomputing the Merkle root.【F:programs/pool/src/lib.rs†L1098-L1115】【F:programs/pool/src/lib.rs†L1395-L1413】 Because the circuit never proves that those leaves were part of the witness, an attacker can append arbitrary commitments, minting value.
* **Exploitation path.** Craft a valid proof that spends real notes (proving nullifier validity) but provide forged output commitments when calling the program. The on-chain code appends the forged leaves, diverging the tree from the circuit state.
* **Mitigations.**
  1. Update the proving circuits so that `new_root` reflects the tree after the outputs are inserted.
  2. Include the `new_root` and each output commitment as public inputs and reject any mismatch on-chain.
  3. Until the new circuits are deployed, gate the affected instructions behind a feature flag or halt shielded operations entirely.
