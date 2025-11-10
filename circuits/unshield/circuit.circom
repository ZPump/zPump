pragma circom 2.1.9;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify/iszero.circom";

// Reference unshield circuit enforcing single-note exit semantics for the MVP.
template UnshieldCircuit() {
    signal input old_root;
    signal input new_root;
    signal input nullifier_hash;
    signal input amount;
    signal input fee;
    signal input dest_pubkey;
    signal input mode;
    signal input mint_id;
    signal input pool_id;

    signal private input note_amount;
    signal private input note_id;
    signal private input spending_key;

    component amountNotZero = IsZero();
    amountNotZero.in <== amount;
    amountNotZero.out === 0;

    // enforce note_amount == amount + fee
    signal sum;
    sum <== amount + fee;
    sum === note_amount;

    component poseidonNullifier = Poseidon(2);
    poseidonNullifier.inputs[0] <== note_id;
    poseidonNullifier.inputs[1] <== spending_key;
    poseidonNullifier.out === nullifier_hash;

    component poseidonRoot = Poseidon(2);
    poseidonRoot.inputs[0] <== old_root;
    poseidonRoot.inputs[1] <== nullifier_hash;
    poseidonRoot.out === new_root;

    signal output accounted_amount;
    accounted_amount <== sum;
}

component main = UnshieldCircuit();
