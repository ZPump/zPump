use ark_bn254::Fr;
use ark_ff::{BigInteger256, Field};

const WIDTH: usize = 3;
const FULL_ROUNDS: usize = 8;
const PARTIAL_ROUNDS: usize = 57;
const TOTAL_ROUNDS: usize = FULL_ROUNDS + PARTIAL_ROUNDS;
const ALPHA: u64 = 5;

const fn fr(limbs: [u64; 4]) -> Fr {
    Fr::new(BigInteger256::new(limbs))
}

pub fn hash_two(left: &Fr, right: &Fr) -> Fr {
    let mut state = [Fr::from(0u64), *left, *right];
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
        *elem = elem.pow([ALPHA]);
    }
}

fn apply_partial_sbox(state: &mut [Fr; WIDTH]) {
    state[0] = state[0].pow([ALPHA]);
}

fn apply_mds(state: &mut [Fr; WIDTH]) {
    let mut next = [Fr::zero(); WIDTH];
    for i in 0..WIDTH {
        for j in 0..WIDTH {
            next[i] += POSEIDON_MDS[i][j] * state[j];
        }
    }
    *state = next;
}

include!("poseidon_consts.in");
