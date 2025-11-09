use anchor_lang::prelude::*;
use sha3::{Digest, Keccak256};

declare_id!("11111111111111111111111111111111");

#[program]
pub mod ptf_verifier_groth16 {
    use super::*;

    pub fn initialize_verifying_key(
        ctx: Context<InitializeVerifyingKey>,
        circuit_tag: [u8; 32],
        hash: [u8; 32],
        version: u8,
    ) -> Result<()> {
        let vk = &mut ctx.accounts.verifying_key;
        vk.authority = ctx.accounts.authority.key();
        vk.circuit_tag = circuit_tag;
        vk.hash = hash;
        vk.bump = ctx.bumps.verifying_key;
        vk.version = version;
        emit!(VerifyingKeyRegistered {
            authority: vk.authority,
            circuit_tag,
            hash,
            version,
        });
        Ok(())
    }

    pub fn verify_groth16(
        ctx: Context<VerifyGroth16>,
        proof: Vec<u8>,
        public_inputs: Vec<u8>,
    ) -> Result<()> {
        let mut hasher = Keccak256::new();
        hasher.update(&proof);
        hasher.update(&public_inputs);
        let digest: [u8; 32] = hasher.finalize().into();
        require!(
            digest == ctx.accounts.verifying_key.hash,
            VerifierError::InvalidProof,
        );
        emit!(ProofVerified {
            circuit_tag: ctx.accounts.verifying_key.circuit_tag,
            hash: ctx.accounts.verifying_key.hash,
            version: ctx.accounts.verifying_key.version,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(circuit_tag: [u8; 32], _hash: [u8; 32], version: u8)]
pub struct InitializeVerifyingKey<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [ptf_common::seeds::VERIFIER, &circuit_tag, &[version]],
        bump,
        space = VerifyingKeyAccount::SPACE,
    )]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    /// Governance or authority that owns this verifying key.
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyGroth16<'info> {
    #[account(
        seeds = [
            ptf_common::seeds::VERIFIER,
            &verifying_key.circuit_tag,
            &[verifying_key.version],
        ],
        bump = verifying_key.bump,
    )]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
}

#[account]
pub struct VerifyingKeyAccount {
    pub authority: Pubkey,
    pub circuit_tag: [u8; 32],
    pub hash: [u8; 32],
    pub bump: u8,
    pub version: u8,
}

impl VerifyingKeyAccount {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 1 + 5;
}

#[event]
pub struct VerifyingKeyRegistered {
    pub authority: Pubkey,
    pub circuit_tag: [u8; 32],
    pub hash: [u8; 32],
    pub version: u8,
}

#[event]
pub struct ProofVerified {
    pub circuit_tag: [u8; 32],
    pub hash: [u8; 32],
    pub version: u8,
}

#[error_code]
pub enum VerifierError {
    #[msg("invalid proof")]
    InvalidProof,
}
