pragma circom 2.1.9;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// Batch private transfer from circuit supporting 2 token transfers in a single proof.
// Each transfer can be for a different mint/pool, allowing spenders to transfer multiple different zTokens atomically.
// Allowances are verified at the program level (not in the circuit).
//
// Structure: Each transfer follows the same structure as TransferCircuit:
// - 2 input notes (can be zeroed if only 1 input needed)
// - 2 output commitments (can be zeroed if only 1 output needed)
// - Value conservation per transfer
// - Root update per mint
//
// Public inputs structure per transfer:
// [old_root_i, new_root_i, nullifier_0_i, nullifier_1_i, output_commitment_0_i, output_commitment_1_i, mint_id_i, pool_id_i]
//
// Total public inputs: For 2 transfers, we have 16 field elements:
// - 2 roots per transfer (old + new) = 4
// - 2 nullifiers per transfer = 4
// - 2 output commitments per transfer = 4
// - 2 identifiers per transfer (mint + pool) = 4
// Total: 16 field elements
//
// Note: Allowance verification happens at the program level (not in the circuit)
// The circuit only verifies the transfer itself (value conservation, nullifiers, etc.)

template BatchTransferFromCircuit2() {
    // Transfer 0 inputs
    signal input old_root_0;
    signal input new_root_0;
    signal input nullifier_0_0;
    signal input nullifier_1_0;
    signal input output_commitment_0_0;
    signal input output_commitment_1_0;
    signal input mint_id_0;
    signal input pool_id_0;
    
    // Transfer 1 inputs
    signal input old_root_1;
    signal input new_root_1;
    signal input nullifier_0_1;
    signal input nullifier_1_1;
    signal input output_commitment_0_1;
    signal input output_commitment_1_1;
    signal input mint_id_1;
    signal input pool_id_1;
    
    // Transfer 0 private witness inputs
    signal input in_note_amount_0_0;
    signal input in_note_amount_1_0;
    signal input in_note_id_0_0;
    signal input in_note_id_1_0;
    signal input in_spending_key_0_0;
    signal input in_spending_key_1_0;
    signal input out_amount_0_0;
    signal input out_amount_1_0;
    signal input out_recipient_0_0;
    signal input out_recipient_1_0;
    signal input out_blinding_0_0;
    signal input out_blinding_1_0;
    
    // Transfer 1 private witness inputs
    signal input in_note_amount_0_1;
    signal input in_note_amount_1_1;
    signal input in_note_id_0_1;
    signal input in_note_id_1_1;
    signal input in_spending_key_0_1;
    signal input in_spending_key_1_1;
    signal input out_amount_0_1;
    signal input out_amount_1_1;
    signal input out_recipient_0_1;
    signal input out_recipient_1_1;
    signal input out_blinding_0_1;
    signal input out_blinding_1_1;
    
    // Process Transfer 0
    component nullifier0_0 = Poseidon(2);
    nullifier0_0.inputs[0] <== in_note_id_0_0;
    nullifier0_0.inputs[1] <== in_spending_key_0_0;
    nullifier0_0.out === nullifier_0_0;
    
    component nullifier1_0 = Poseidon(2);
    nullifier1_0.inputs[0] <== in_note_id_1_0;
    nullifier1_0.inputs[1] <== in_spending_key_1_0;
    nullifier1_0.out === nullifier_1_0;
    
    component commitment0_0 = Poseidon(5);
    commitment0_0.inputs[0] <== out_amount_0_0;
    commitment0_0.inputs[1] <== out_recipient_0_0;
    commitment0_0.inputs[2] <== mint_id_0;
    commitment0_0.inputs[3] <== pool_id_0;
    commitment0_0.inputs[4] <== out_blinding_0_0;
    commitment0_0.out === output_commitment_0_0;
    
    component commitment1_0 = Poseidon(5);
    commitment1_0.inputs[0] <== out_amount_1_0;
    commitment1_0.inputs[1] <== out_recipient_1_0;
    commitment1_0.inputs[2] <== mint_id_0;
    commitment1_0.inputs[3] <== pool_id_0;
    commitment1_0.inputs[4] <== out_blinding_1_0;
    commitment1_0.out === output_commitment_1_0;
    
    signal inputs_sum_0;
    signal outputs_sum_0;
    inputs_sum_0 <== in_note_amount_0_0 + in_note_amount_1_0;
    outputs_sum_0 <== out_amount_0_0 + out_amount_1_0;
    inputs_sum_0 === outputs_sum_0;
    
    component rootUpdate_0 = Poseidon(3);
    rootUpdate_0.inputs[0] <== old_root_0;
    rootUpdate_0.inputs[1] <== nullifier_0_0;
    rootUpdate_0.inputs[2] <== nullifier_1_0;
    rootUpdate_0.out === new_root_0;
    
    // Process Transfer 1
    component nullifier0_1 = Poseidon(2);
    nullifier0_1.inputs[0] <== in_note_id_0_1;
    nullifier0_1.inputs[1] <== in_spending_key_0_1;
    nullifier0_1.out === nullifier_0_1;
    
    component nullifier1_1 = Poseidon(2);
    nullifier1_1.inputs[0] <== in_note_id_1_1;
    nullifier1_1.inputs[1] <== in_spending_key_1_1;
    nullifier1_1.out === nullifier_1_1;
    
    component commitment0_1 = Poseidon(5);
    commitment0_1.inputs[0] <== out_amount_0_1;
    commitment0_1.inputs[1] <== out_recipient_0_1;
    commitment0_1.inputs[2] <== mint_id_1;
    commitment0_1.inputs[3] <== pool_id_1;
    commitment0_1.inputs[4] <== out_blinding_0_1;
    commitment0_1.out === output_commitment_0_1;
    
    component commitment1_1 = Poseidon(5);
    commitment1_1.inputs[0] <== out_amount_1_1;
    commitment1_1.inputs[1] <== out_recipient_1_1;
    commitment1_1.inputs[2] <== mint_id_1;
    commitment1_1.inputs[3] <== pool_id_1;
    commitment1_1.inputs[4] <== out_blinding_1_1;
    commitment1_1.out === output_commitment_1_1;
    
    signal inputs_sum_1;
    signal outputs_sum_1;
    inputs_sum_1 <== in_note_amount_0_1 + in_note_amount_1_1;
    outputs_sum_1 <== out_amount_0_1 + out_amount_1_1;
    inputs_sum_1 === outputs_sum_1;
    
    component rootUpdate_1 = Poseidon(3);
    rootUpdate_1.inputs[0] <== old_root_1;
    rootUpdate_1.inputs[1] <== nullifier_0_1;
    rootUpdate_1.inputs[2] <== nullifier_1_1;
    rootUpdate_1.out === new_root_1;
    
    // Output totals transferred (for debugging/info)
    signal output total_transferred_0;
    signal output total_transferred_1;
    total_transferred_0 <== outputs_sum_0;
    total_transferred_1 <== outputs_sum_1;
}

component main = BatchTransferFromCircuit2();

