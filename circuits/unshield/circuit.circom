pragma circom 2.1.9;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Reference unshield circuit enforcing single-note exit semantics for the MVP.
template UnshieldCircuit() {
    signal input old_root;
    signal input new_root;
    signal input nullifier_hash;
    signal input change_commitment;
    signal input change_amount_commitment;
    signal input amount;
    signal input fee;
    signal input dest_pubkey;
    signal input mode;
    signal input mint_id;
    signal input pool_id;

    signal input note_amount;
    signal input note_id;
    signal input spending_key;
    signal input change_amount;
    signal input change_recipient;
    signal input change_blinding;
    signal input change_amount_blinding;

    component amountNotZero = IsZero();
    amountNotZero.in <== amount;
    amountNotZero.out === 0;

    // enforce note_amount == amount + fee + change_amount
    signal total_outflow;
    total_outflow <== amount + fee + change_amount;
    total_outflow === note_amount;

    component poseidonNullifier = Poseidon(2);
    poseidonNullifier.inputs[0] <== note_id;
    poseidonNullifier.inputs[1] <== spending_key;
    poseidonNullifier.out === nullifier_hash;

    component poseidonChangeCommitment = Poseidon(5);
    poseidonChangeCommitment.inputs[0] <== change_amount;
    poseidonChangeCommitment.inputs[1] <== change_recipient;
    poseidonChangeCommitment.inputs[2] <== mint_id;
    poseidonChangeCommitment.inputs[3] <== pool_id;
    poseidonChangeCommitment.inputs[4] <== change_blinding;
    poseidonChangeCommitment.out === change_commitment;

    component poseidonChangeAmountCommitment = Poseidon(2);
    poseidonChangeAmountCommitment.inputs[0] <== change_amount;
    poseidonChangeAmountCommitment.inputs[1] <== change_amount_blinding;
    poseidonChangeAmountCommitment.out === change_amount_commitment;

    component poseidonRoot = Poseidon(4);
    poseidonRoot.inputs[0] <== old_root;
    poseidonRoot.inputs[1] <== nullifier_hash;
    poseidonRoot.inputs[2] <== change_commitment;
    poseidonRoot.inputs[3] <== change_amount_commitment;
    poseidonRoot.out === new_root;

    signal output accounted_amount;
    accounted_amount <== total_outflow;
}

component main = UnshieldCircuit();
