pragma circom 2.1.9;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify/iszero.circom";

// Reference private transfer circuit supporting two-in/two-out notes.
template TransferCircuit() {
    signal input old_root;
    signal input new_root;
    signal input nullifier_0;
    signal input nullifier_1;
    signal input output_commitment_0;
    signal input output_commitment_1;
    signal input mint_id;
    signal input pool_id;

    signal private input in_note_amount_0;
    signal private input in_note_amount_1;
    signal private input in_note_id_0;
    signal private input in_note_id_1;
    signal private input in_spending_key_0;
    signal private input in_spending_key_1;

    signal private input out_amount_0;
    signal private input out_amount_1;
    signal private input out_recipient_0;
    signal private input out_recipient_1;
    signal private input out_blinding_0;
    signal private input out_blinding_1;

    // Nullifiers
    component nullifier0 = Poseidon(2);
    nullifier0.inputs[0] <== in_note_id_0;
    nullifier0.inputs[1] <== in_spending_key_0;
    nullifier0.out === nullifier_0;

    component nullifier1 = Poseidon(2);
    nullifier1.inputs[0] <== in_note_id_1;
    nullifier1.inputs[1] <== in_spending_key_1;
    nullifier1.out === nullifier_1;

    // Output commitments
    component commitment0 = Poseidon(5);
    commitment0.inputs[0] <== out_amount_0;
    commitment0.inputs[1] <== out_recipient_0;
    commitment0.inputs[2] <== mint_id;
    commitment0.inputs[3] <== pool_id;
    commitment0.inputs[4] <== out_blinding_0;
    commitment0.out === output_commitment_0;

    component commitment1 = Poseidon(5);
    commitment1.inputs[0] <== out_amount_1;
    commitment1.inputs[1] <== out_recipient_1;
    commitment1.inputs[2] <== mint_id;
    commitment1.inputs[3] <== pool_id;
    commitment1.inputs[4] <== out_blinding_1;
    commitment1.out === output_commitment_1;

    // Value conservation
    signal inputs_sum;
    signal outputs_sum;
    inputs_sum <== in_note_amount_0 + in_note_amount_1;
    outputs_sum <== out_amount_0 + out_amount_1;
    inputs_sum === outputs_sum;

    component rootUpdate = Poseidon(3);
    rootUpdate.inputs[0] <== old_root;
    rootUpdate.inputs[1] <== nullifier_0;
    rootUpdate.inputs[2] <== nullifier_1;
    rootUpdate.out === new_root;

    signal output total_transferred;
    total_transferred <== outputs_sum;
}

component main = TransferCircuit();
