use ark_bn254::Fr;
use ark_ff::{BigInteger256, Field, Zero};

const WIDTH: usize = 3;
const FULL_ROUNDS: usize = 8;
const PARTIAL_ROUNDS: usize = 57;

const fn fr(limbs: [u64; 4]) -> Fr {
    Fr::new(BigInteger256::new(limbs))
}

#[inline(always)]
pub fn hash_two(left: &Fr, right: &Fr) -> Fr {
    let mut state = [Fr::zero(), *left, *right];
    apply_permutation(&mut state);
    state[0]
}

fn apply_permutation(state: &mut [Fr; WIDTH]) {
    let mut round = 0usize;

    for _ in 0..(FULL_ROUNDS / 2) {
        add_round_constants(state, round);
        apply_full_sbox(state);
        apply_mds(state);
        round += 1;
    }

    for _ in 0..PARTIAL_ROUNDS {
        add_round_constants(state, round);
        apply_partial_sbox(state);
        apply_mds(state);
        round += 1;
    }

    for _ in 0..(FULL_ROUNDS / 2) {
        add_round_constants(state, round);
        apply_full_sbox(state);
        apply_mds(state);
        round += 1;
    }
}

fn add_round_constants(state: &mut [Fr; WIDTH], round: usize) {
    for i in 0..WIDTH {
        state[i] += POSEIDON_ARC[round * WIDTH + i];
    }
}

fn apply_full_sbox(state: &mut [Fr; WIDTH]) {
    for elem in state.iter_mut() {
        quintic_pow_in_place(elem);
    }
}

fn apply_partial_sbox(state: &mut [Fr; WIDTH]) {
    quintic_pow_in_place(&mut state[0]);
}

fn apply_mds(state: &mut [Fr; WIDTH]) {
    let mut next = [Fr::zero(); WIDTH];
    for (row_index, row) in POSEIDON_MDS.iter().enumerate() {
        let mut acc = Fr::zero();
        for (coeff, value) in row.iter().zip(state.iter()) {
            acc += *coeff * value;
        }
        next[row_index] = acc;
    }
    *state = next;
}

#[inline(always)]
fn quintic_pow_in_place(value: &mut Fr) {
    let mut sq = *value;
    sq.square_in_place();
    let mut quad = sq;
    quad.square_in_place();
    *value *= quad;
}

include!("poseidon_consts.in");
