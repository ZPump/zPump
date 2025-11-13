pragma circom 2.1.9;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Reference implementation of the PTF shield circuit.
// This circuit deliberately keeps the arithmetic minimal so it can be audited easily.
template ShieldCircuit() {
    // Public inputs (all field elements on BN254)
    signal input old_root;
    signal input new_root;
    signal input commitment_hash;
    signal input mint_id;
    signal input pool_id;
    signal input deposit_id;

    // Private witness
    signal input amount;
    signal input recipient_pk;
    signal input blinding;

    // Amount must be non-zero
    component amountNotZero = IsZero();
    amountNotZero.in <== amount;
    amountNotZero.out === 0;

    // Compute commitment hash: Poseidon(amount, recipient_pk, deposit_id, pool_id, blinding)
    component poseidonCommit = Poseidon(5);
    poseidonCommit.inputs[0] <== amount;
    poseidonCommit.inputs[1] <== recipient_pk;
    poseidonCommit.inputs[2] <== deposit_id;
    poseidonCommit.inputs[3] <== pool_id;
    poseidonCommit.inputs[4] <== blinding;
    poseidonCommit.out === commitment_hash;

    // Derive a deterministic next root placeholder by mixing in the new commitment.
    // Production deployments will use an incremental Merkle tree outside the circuit.
    component poseidonRoot = Poseidon(2);
    poseidonRoot.inputs[0] <== old_root;
    poseidonRoot.inputs[1] <== commitment_hash;
    poseidonRoot.out === new_root;

    // Output used by the on-chain event payload for documentation parity.
    signal output note_commitment;
    note_commitment <== commitment_hash;
}

component main = ShieldCircuit();
