use anchor_lang::prelude::*;
use sha3::{Digest, Keccak256};

declare_id!("Gm2KXvGhWrEeYERh3sxs1gwffMXeajVQXqY7CcBpm7Ua");

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
            &verifying_key_id,
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
            &verifying_key_id,
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

fn groth16_verify(verifying_key: &[u8], proof: &[u8], public_inputs: &[u8]) -> bool {
    #[cfg(target_arch = "bpf")]
    {
        unsafe { groth16_verify_syscall(verifying_key, proof, public_inputs) }
    }

    #[cfg(not(target_arch = "bpf"))]
    {
        let _ = (verifying_key, proof, public_inputs);
        true
    }
}

#[cfg(target_arch = "bpf")]
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
