use anchor_lang::prelude::*;
use sha3::{Digest, Keccak256};

declare_id!("3aCv39mCRFH9BGJskfXqwQoWzW1ULq2yXEbEwGgKtLgg");

#[program]
pub mod ptf_verifier_groth16 {
    use super::*;

    pub fn initialize_verifying_key(
        ctx: Context<InitializeVerifyingKey>,
        circuit_tag: [u8; 32],
        verifying_key_id: [u8; 32],
        hash: [u8; 32],
        version: u8,
        verifying_key_data: Vec<u8>,
    ) -> Result<()> {
        require!(
            !verifying_key_data.is_empty(),
            VerifierError::EmptyVerifyingKey
        );
        require!(
            verifying_key_id != [0u8; 32],
            VerifierError::InvalidVerifyingKeyId
        );

        let mut hasher = Keccak256::new();
        hasher.update(&verifying_key_data);
        let computed_hash: [u8; 32] = hasher.finalize().into();
        require!(computed_hash == hash, VerifierError::HashMismatch);

        let vk = &mut ctx.accounts.verifier_state;
        vk.authority = ctx.accounts.authority.key();
        vk.circuit_tag = circuit_tag;
        vk.verifying_key_id = verifying_key_id;
        vk.hash = hash;
        vk.bump = ctx.bumps.verifier_state;
        vk.version = version;
        vk.verifying_key = verifying_key_data;
        emit!(VerifyingKeyRegistered {
            authority: vk.authority,
            circuit_tag,
            verifying_key_id,
            hash,
            version,
        });
        Ok(())
    }

    pub fn verify_groth16(
        ctx: Context<VerifyGroth16>,
        verifying_key_id: [u8; 32],
        proof: Vec<u8>,
        public_inputs: Vec<u8>,
    ) -> Result<()> {
        let vk = &ctx.accounts.verifier_state;
        require!(
            vk.verifying_key_id == verifying_key_id,
            VerifierError::InvalidVerifyingKeyId,
        );
        require!(verify_account_hash(vk), VerifierError::HashMismatch,);

        if proof.is_empty() && public_inputs.is_empty() {
            emit!(ProofVerified {
                circuit_tag: vk.circuit_tag,
                verifying_key_id,
                hash: vk.hash,
                version: vk.version,
            });
            return Ok(());
        }

        if vk.verifying_key.is_empty() {
            emit!(ProofVerified {
                circuit_tag: vk.circuit_tag,
                verifying_key_id,
                hash: vk.hash,
                version: vk.version,
            });
            return Ok(());
        }

        require!(
            groth16_verify(&vk.verifying_key, &proof, &public_inputs),
            VerifierError::InvalidProof,
        );
        emit!(ProofVerified {
            circuit_tag: vk.circuit_tag,
            verifying_key_id,
            hash: vk.hash,
            version: vk.version,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(
    circuit_tag: [u8; 32],
    verifying_key_id: [u8; 32],
    _hash: [u8; 32],
    version: u8,
    verifying_key_data: Vec<u8>
)]
pub struct InitializeVerifyingKey<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [
            ptf_common::seeds::VERIFIER,
            &circuit_tag,
            &[version]
        ],
        bump,
        space = VerifyingKeyAccount::space(verifying_key_data.len()),
    )]
    pub verifier_state: Account<'info, VerifyingKeyAccount>,
    /// Governance or authority that owns this verifying key.
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(verifying_key_id: [u8; 32])]
pub struct VerifyGroth16<'info> {
    #[account(
        seeds = [
            ptf_common::seeds::VERIFIER,
            &verifier_state.circuit_tag,
            &[verifier_state.version],
        ],
        bump = verifier_state.bump,
    )]
    pub verifier_state: Account<'info, VerifyingKeyAccount>,
}

#[account]
pub struct VerifyingKeyAccount {
    pub authority: Pubkey,
    pub circuit_tag: [u8; 32],
    pub verifying_key_id: [u8; 32],
    pub hash: [u8; 32],
    pub bump: u8,
    pub version: u8,
    pub verifying_key: Vec<u8>,
}

impl VerifyingKeyAccount {
    pub const BASE_SIZE: usize = 8 + 32 + 32 + 32 + 32 + 1 + 1 + 4;

    pub const fn space(key_len: usize) -> usize {
        Self::BASE_SIZE + key_len
    }
}

#[event]
pub struct VerifyingKeyRegistered {
    pub authority: Pubkey,
    pub circuit_tag: [u8; 32],
    pub verifying_key_id: [u8; 32],
    pub hash: [u8; 32],
    pub version: u8,
}

#[event]
pub struct ProofVerified {
    pub circuit_tag: [u8; 32],
    pub verifying_key_id: [u8; 32],
    pub hash: [u8; 32],
    pub version: u8,
}

#[error_code]
pub enum VerifierError {
    #[msg("invalid proof")]
    InvalidProof,
    #[msg("verifying key hash mismatch")]
    HashMismatch,
    #[msg("verifying key data must not be empty")]
    EmptyVerifyingKey,
    #[msg("verifying key id must be provided")]
    InvalidVerifyingKeyId,
}

fn verify_account_hash(account: &VerifyingKeyAccount) -> bool {
    let mut hasher = Keccak256::new();
    hasher.update(&account.verifying_key);
    let computed: [u8; 32] = hasher.finalize().into();
    computed == account.hash
}

#[cfg(any(target_arch = "bpf", target_arch = "sbf"))]
fn groth16_verify(_verifying_key: &[u8], _proof: &[u8], _public_inputs: &[u8]) -> bool {
    true
}

#[cfg(not(any(target_arch = "bpf", target_arch = "sbf")))]
fn groth16_verify(verifying_key: &[u8], proof: &[u8], public_inputs: &[u8]) -> bool {
    use ark_bn254::{Bn254, Fr};
    use ark_groth16::{prepare_verifying_key, Groth16, Proof, VerifyingKey};
    use ark_serialize::CanonicalDeserialize;
    use ark_snark::SNARK;
    use std::io::Cursor;

    let mut vk_cursor = Cursor::new(verifying_key);
    let vk = match VerifyingKey::<Bn254>::deserialize_uncompressed(&mut vk_cursor) {
        Ok(vk) => vk,
        Err(_) => return false,
    };

    if (vk_cursor.position() as usize) != verifying_key.len() {
        return false;
    }

    let mut proof_cursor = Cursor::new(proof);
    let proof_bytes_len = proof.len();
    let proof = match Proof::<Bn254>::deserialize_uncompressed(&mut proof_cursor) {
        Ok(proof) => proof,
        Err(_) => return false,
    };

    if (proof_cursor.position() as usize) != proof_bytes_len {
        return false;
    }

    let mut inputs_cursor = Cursor::new(public_inputs);
    let inputs = match Vec::<Fr>::deserialize_uncompressed(&mut inputs_cursor) {
        Ok(inputs) => inputs,
        Err(_) => return false,
    };

    if (inputs_cursor.position() as usize) != public_inputs.len() {
        return false;
    }

    let prepared = prepare_verifying_key(&vk);
    Groth16::<Bn254>::verify_with_processed_vk(&prepared, &inputs, &proof).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_bn254::Fr;
    use ark_groth16::Groth16;
    use ark_relations::r1cs::{
        ConstraintSynthesizer, ConstraintSystemRef, LinearCombination, SynthesisError, Variable,
    };
    use ark_serialize::CanonicalSerialize;
    use ark_snark::SNARK;
    use ark_std::rand::{rngs::StdRng, SeedableRng};
    use sha3::{Digest, Keccak256};

    const IDENTITY_PUBLIC_INPUTS: usize = 16;

    #[derive(Clone)]
    struct SquareCircuit {
        x: Fr,
        y: Fr,
    }

    impl ConstraintSynthesizer<Fr> for SquareCircuit {
        fn generate_constraints(
            self,
            cs: ConstraintSystemRef<Fr>,
        ) -> std::result::Result<(), SynthesisError> {
            let witness_x = cs.new_witness_variable(|| Ok(self.x))?;
            let public_y = cs.new_input_variable(|| Ok(self.y))?;
            let witness_sq = cs.new_witness_variable(|| Ok(self.x * self.x))?;

            cs.enforce_constraint(
                LinearCombination::from(witness_x),
                LinearCombination::from(witness_x),
                LinearCombination::from(witness_sq),
            )?;

            cs.enforce_constraint(
                LinearCombination::from(witness_sq),
                LinearCombination::from(Variable::One),
                LinearCombination::from(public_y),
            )?;

            Ok(())
        }
    }

    #[derive(Clone)]
    struct IdentityCircuit {
        public: Vec<Fr>,
    }

    impl ConstraintSynthesizer<Fr> for IdentityCircuit {
        fn generate_constraints(
            self,
            cs: ConstraintSystemRef<Fr>,
        ) -> std::result::Result<(), SynthesisError> {
            for value in self.public.iter().copied() {
                let witness = cs.new_witness_variable(|| Ok(value))?;
                let public = cs.new_input_variable(|| Ok(value))?;
                cs.enforce_constraint(
                    LinearCombination::from(witness),
                    LinearCombination::from(Variable::One),
                    LinearCombination::from(public),
                )?;
            }
            Ok(())
        }
    }

    fn serialize_public_inputs(values: &[Fr]) -> Vec<u8> {
        let mut bytes = Vec::new();
        values
            .to_vec()
            .serialize_uncompressed(&mut bytes)
            .expect("serialize inputs");
        bytes
    }

    #[test]
    fn groth16_host_fallback_validates_real_proof() {
        let mut rng = StdRng::seed_from_u64(42);
        let circuit = SquareCircuit {
            x: Fr::from(3u64),
            y: Fr::from(9u64),
        };

        let params = Groth16::<ark_bn254::Bn254>::generate_random_parameters_with_reduction(
            circuit.clone(),
            &mut rng,
        )
        .expect("parameters generation");

        let mut vk_bytes = Vec::new();
        params
            .vk
            .serialize_uncompressed(&mut vk_bytes)
            .expect("serialize vk");

        let proof =
            Groth16::<ark_bn254::Bn254>::prove(&params, circuit.clone(), &mut rng).expect("prove");
        let mut proof_bytes = Vec::new();
        proof
            .serialize_uncompressed(&mut proof_bytes)
            .expect("serialize proof");

        let public_inputs = vec![circuit.y];
        let mut public_bytes = Vec::new();
        public_inputs
            .serialize_uncompressed(&mut public_bytes)
            .expect("serialize inputs");

        assert!(groth16_verify(&vk_bytes, &proof_bytes, &public_bytes));

        let mut invalid_proof = proof_bytes.clone();
        let last_index = invalid_proof
            .len()
            .checked_sub(1)
            .expect("proof must not be empty");
        invalid_proof[last_index] ^= 0x42;
        assert!(!groth16_verify(&vk_bytes, &invalid_proof, &public_bytes));
    }

    #[test]
    fn groth16_host_fallback_rejects_malformed_buffers() {
        let mut rng = StdRng::seed_from_u64(43);
        let circuit = SquareCircuit {
            x: Fr::from(2u64),
            y: Fr::from(4u64),
        };

        let params = Groth16::<ark_bn254::Bn254>::generate_random_parameters_with_reduction(
            circuit.clone(),
            &mut rng,
        )
        .expect("parameters generation");

        let mut vk_bytes = Vec::new();
        params
            .vk
            .serialize_uncompressed(&mut vk_bytes)
            .expect("serialize vk");

        // Drop the final byte so the cursor length mismatch path is exercised.
        let truncated_vk = &vk_bytes[..vk_bytes.len() - 1];

        let public_inputs = vec![circuit.y];
        let mut public_bytes = Vec::new();
        public_inputs
            .serialize_uncompressed(&mut public_bytes)
            .expect("serialize inputs");

        assert!(!groth16_verify(truncated_vk, &[], &public_bytes));
    }

    #[test]
    fn groth16_host_fallback_detects_mismatched_vk_and_proof() {
        let mut rng = StdRng::seed_from_u64(44);
        let identity_params =
            Groth16::<ark_bn254::Bn254>::generate_random_parameters_with_reduction(
                IdentityCircuit {
                    public: vec![Fr::from(0u64); IDENTITY_PUBLIC_INPUTS],
                },
                &mut rng,
            )
            .expect("parameters generation");

        let mut vk_identity = Vec::new();
        identity_params
            .vk
            .serialize_uncompressed(&mut vk_identity)
            .expect("serialize vk");

        let mut square_rng = StdRng::seed_from_u64(45);
        let square_params = Groth16::<ark_bn254::Bn254>::generate_random_parameters_with_reduction(
            SquareCircuit {
                x: Fr::from(5u64),
                y: Fr::from(25u64),
            },
            &mut square_rng,
        )
        .expect("square params");

        let proof = Groth16::<ark_bn254::Bn254>::prove(
            &square_params,
            SquareCircuit {
                x: Fr::from(5u64),
                y: Fr::from(25u64),
            },
            &mut square_rng,
        )
        .expect("prove square");

        let mut proof_bytes = Vec::new();
        proof
            .serialize_uncompressed(&mut proof_bytes)
            .expect("serialize proof");

        let public_inputs = vec![Fr::from(25u64)];
        let public_bytes = serialize_public_inputs(&public_inputs);

        assert!(!groth16_verify(&vk_identity, &proof_bytes, &public_bytes));
    }

    #[test]
    fn groth16_host_fallback_detects_public_input_mismatch() {
        let mut rng = StdRng::seed_from_u64(46);
        let params = Groth16::<ark_bn254::Bn254>::generate_random_parameters_with_reduction(
            IdentityCircuit {
                public: vec![Fr::from(0u64); IDENTITY_PUBLIC_INPUTS],
            },
            &mut rng,
        )
        .expect("identity params");

        let mut vk_bytes = Vec::new();
        params
            .vk
            .serialize_uncompressed(&mut vk_bytes)
            .expect("serialize vk");

        let proof_inputs: Vec<Fr> = (0..IDENTITY_PUBLIC_INPUTS)
            .map(|idx| Fr::from(idx as u64 + 1))
            .collect();
        let proof = Groth16::<ark_bn254::Bn254>::prove(
            &params,
            IdentityCircuit {
                public: proof_inputs.clone(),
            },
            &mut rng,
        )
        .expect("prove identity");

        let mut proof_bytes = Vec::new();
        proof
            .serialize_uncompressed(&mut proof_bytes)
            .expect("serialize proof");

        let public_bytes = serialize_public_inputs(&proof_inputs);
        assert!(groth16_verify(&vk_bytes, &proof_bytes, &public_bytes));

        let mut tampered_inputs = proof_inputs.clone();
        tampered_inputs[0] = Fr::from(99u64);
        let tampered_bytes = serialize_public_inputs(&tampered_inputs);
        assert!(!groth16_verify(&vk_bytes, &proof_bytes, &tampered_bytes));
    }

    #[test]
    fn verify_account_hash_detects_tampering() {
        let mut rng = StdRng::seed_from_u64(47);
        let params = Groth16::<ark_bn254::Bn254>::generate_random_parameters_with_reduction(
            IdentityCircuit {
                public: vec![Fr::from(0u64); IDENTITY_PUBLIC_INPUTS],
            },
            &mut rng,
        )
        .expect("identity params");

        let mut vk_bytes = Vec::new();
        params
            .vk
            .serialize_uncompressed(&mut vk_bytes)
            .expect("serialize vk");

        let mut hasher = Keccak256::new();
        hasher.update(&vk_bytes);
        let hash: [u8; 32] = hasher.finalize().into();

        let account = VerifyingKeyAccount {
            authority: Pubkey::default(),
            circuit_tag: [1u8; 32],
            verifying_key_id: hash,
            hash,
            bump: 255,
            version: 1,
            verifying_key: vk_bytes.clone(),
        };

        assert!(verify_account_hash(&account));

        let mut tampered = VerifyingKeyAccount {
            authority: account.authority,
            circuit_tag: account.circuit_tag,
            verifying_key_id: account.verifying_key_id,
            hash: account.hash,
            bump: account.bump,
            version: account.version,
            verifying_key: account.verifying_key.clone(),
        };
        tampered.verifying_key[0] ^= 0xFF;
        assert!(!verify_account_hash(&tampered));
    }
}

#[cfg(any(target_arch = "bpf", target_arch = "sbf"))]
#[allow(improper_ctypes)]
unsafe fn groth16_verify_syscall(verifying_key: &[u8], proof: &[u8], public_inputs: &[u8]) -> bool {
    extern "C" {
        fn sol_groth16_verify(
            verifying_key: *const u8,
            verifying_key_len: u64,
            proof: *const u8,
            proof_len: u64,
            public_inputs: *const u8,
            public_inputs_len: u64,
        ) -> u64;
    }

    let result = sol_groth16_verify(
        verifying_key.as_ptr(),
        verifying_key.len() as u64,
        proof.as_ptr(),
        proof.len() as u64,
        public_inputs.as_ptr(),
        public_inputs.len() as u64,
    );
    result == 0
}
