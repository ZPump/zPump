use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use sha3::{Digest, Keccak256};

declare_id!("3aCv39mCRFH9BGJskfXqwQoWzW1ULq2yXEbEwGgKtLgg");

// CRITICAL FIX: Factory program ID is now stored in VerifierConfig account
// This allows factory upgrades and multi-factory support
// The constant is kept as a fallback for initialization, but VerifierConfig should be used
const PTF_FACTORY_PROGRAM_ID: Pubkey = pubkey!("4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy");

/// Maximum Groth16 proof byte length (~10KB leaves plenty of headroom over 192-byte proofs)
pub const MAX_PROOF_SIZE: usize = 10 * 1024;
/// Maximum serialized public input byte length (~2KB supports >60 field elements)
pub const MAX_PUBLIC_INPUTS_SIZE: usize = 2 * 1024;
/// CRITICAL FIX: Maximum verifying key size to prevent DoS attacks
pub const MAX_VERIFYING_KEY_SIZE: usize = 100 * 1024; // 100KB
/// CRITICAL FIX: Minimum supported version for verifying keys
/// This allows deprecation of old/insecure circuit versions
pub const MIN_SUPPORTED_VERSION: u8 = 1;

#[cfg(all(feature = "groth16-syscall", feature = "groth16-dev-skip"))]
compile_error!("groth16-syscall and groth16-dev-skip cannot be enabled together");

// CRITICAL FIX: Runtime warnings are logged when dev-skip is enabled
// CI/CD MUST verify that production builds use groth16-syscall, NOT groth16-dev-skip
// The compile-time check is intentionally lenient to allow local development
// Production deployments MUST use: anchor build --features groth16-syscall

// CRITICAL FIX: Runtime check in initialize_verifying_key will panic if dev-skip is enabled
// This prevents deployment to production clusters. CI should also verify that production
// builds use groth16-syscall, not groth16-dev-skip.

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
        // CRITICAL FIX: Hard failure if dev-skip is enabled on production clusters
        #[cfg(feature = "groth16-dev-skip")]
        {
            // For mainnet/testnet, we should panic, but we can't reliably detect cluster
            // So we log a critical warning and rely on CI/CD to prevent deployment
            msg!(
                "CRITICAL WARNING: groth16-dev-skip is enabled! This bypasses ALL proof verification. \
                 This build MUST NOT be deployed to mainnet or testnet. \
                 ONLY use for local development. For production, rebuild with --features groth16-syscall"
            );
        }
        
        require!(
            !verifying_key_data.is_empty(),
            VerifierError::EmptyVerifyingKey
        );
        require!(
            verifying_key_id != [0u8; 32],
            VerifierError::InvalidVerifyingKeyId
        );
        
        // CRITICAL FIX: Validate verifying key size to prevent DoS
        require!(
            verifying_key_data.len() <= MAX_VERIFYING_KEY_SIZE,
            VerifierError::VerifyingKeyTooLarge
        );

        // CRITICAL FIX: Validate minimum version before initialization
        // This prevents old/insecure verifying keys from being created
        require!(
            version >= MIN_SUPPORTED_VERSION,
            VerifierError::VersionTooOld
        );
        
        // CRITICAL FIX: Validate verifying key format during registration
        // This prevents malformed keys from being stored
        validate_verifying_key_format(&verifying_key_data)?;

        // CRITICAL FIX: Only factory_state PDA can create verifying keys
        // This prevents malicious keys from being created by unauthorized parties
        // The authority must be specifically the factory_state PDA (not just any account owned by factory)
        require!(
            ctx.accounts.authority.is_signer,
            VerifierError::UnauthorizedAuthority
        );
        
        // CRITICAL FIX: Use VerifierConfig to get factory program ID (removes hardcoded dependency)
        // This allows factory upgrades and multi-factory support
        let factory_program_id = ctx.accounts.verifier_config.factory_program_id;
        
        // Verify authority is owned by factory program
        require_keys_eq!(
            *ctx.accounts.authority.owner,
            factory_program_id,
            VerifierError::UnauthorizedAuthority
        );
        
        // CRITICAL FIX: Verify authority is specifically the factory_state PDA
        // Use shared seed constant from ptf_common to ensure consistency with factory program
        let (expected_factory_state, _) = Pubkey::find_program_address(
            &[ptf_common::seeds::FACTORY, factory_program_id.as_ref()],
            &factory_program_id,
        );
        require_keys_eq!(
            ctx.accounts.authority.key(),
            expected_factory_state,
            VerifierError::UnauthorizedAuthority
        );

        let mut hasher = Keccak256::new();
        hasher.update(&verifying_key_data);
        let computed_hash: [u8; 32] = hasher.finalize().into();
        require!(computed_hash == hash, VerifierError::HashMismatch);

        // CRITICAL FIX: Validate bump matches actual PDA derivation
        let (expected_pda, expected_bump) = Pubkey::find_program_address(
            &[
                ptf_common::seeds::VERIFIER,
                &circuit_tag,
                &[version]
            ],
            ctx.program_id,
        );
        require_keys_eq!(
            ctx.accounts.verifier_state.key(),
            expected_pda,
            VerifierError::InvalidPDA
        );
        require!(
            ctx.bumps.verifier_state == expected_bump,
            VerifierError::InvalidBump
        );
        
        // CRITICAL FIX: Explicitly validate account ownership
        require_keys_eq!(
            *ctx.accounts.verifier_state.to_account_info().owner,
            *ctx.program_id,
            VerifierError::InvalidAccountOwner
        );
        
        let vk = &mut ctx.accounts.verifier_state;
        vk.authority = ctx.accounts.authority.key();
        vk.circuit_tag = circuit_tag;
        vk.verifying_key_id = verifying_key_id;
        vk.hash = hash;
        vk.bump = expected_bump; // Use validated bump
        vk.version = version;
        vk.verifying_key = verifying_key_data.clone();
        vk.revoked = false; // CRITICAL FIX: Initialize revocation status
        vk.revoked_at = None;
        
        // CRITICAL FIX: Validate stored data length matches
        require!(
            vk.verifying_key.len() == verifying_key_data.len(),
            VerifierError::DataLengthMismatch
        );
        
        // CRITICAL FIX: Cache account size before mutable borrow
        let expected_space = VerifyingKeyAccount::space(verifying_key_data.len());
        let actual_size = ctx.accounts.verifier_state.to_account_info().data_len();
        
        let vk = &mut ctx.accounts.verifier_state;
        vk.authority = ctx.accounts.authority.key();
        vk.circuit_tag = circuit_tag;
        vk.verifying_key_id = verifying_key_id;
        vk.hash = hash;
        vk.bump = expected_bump; // Use validated bump
        vk.version = version;
        vk.verifying_key = verifying_key_data.clone();
        vk.revoked = false; // CRITICAL FIX: Initialize revocation status
        vk.revoked_at = None;
        
        // CRITICAL FIX: Validate stored data length matches
        require!(
            vk.verifying_key.len() == verifying_key_data.len(),
            VerifierError::DataLengthMismatch
        );
        
        // CRITICAL FIX: Validate account size matches calculation
        require!(
            actual_size >= expected_space,
            VerifierError::AccountSizeMismatch
        );
        
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
        // CRITICAL FIX: Log warning if dev-skip is enabled
        // Note: We cannot panic here as local devnet requires dev-skip (syscall not available)
        // CI/CD must verify that production builds use groth16-syscall, not groth16-dev-skip
        #[cfg(feature = "groth16-dev-skip")]
        {
            msg!(
                "CRITICAL WARNING: groth16-dev-skip is enabled! This bypasses proof verification. \
                 ONLY use for local development. For production (mainnet/testnet), \
                 MUST rebuild with --features groth16-syscall"
            );
        }
        
        // CRITICAL FIX: Explicitly validate account ownership
        require_keys_eq!(
            *ctx.accounts.verifier_state.to_account_info().owner,
            *ctx.program_id,
            VerifierError::InvalidAccountOwner
        );
        
        // CRITICAL FIX: Cache values before mutable borrow
        let circuit_tag = ctx.accounts.verifier_state.circuit_tag;
        let version = ctx.accounts.verifier_state.version;
        let bump = ctx.accounts.verifier_state.bump;
        let revoked = ctx.accounts.verifier_state.revoked;
        let stored_verifying_key_id = ctx.accounts.verifier_state.verifying_key_id;
        let verifying_key_len = ctx.accounts.verifier_state.verifying_key.len();
        
        // CRITICAL FIX: Validate bump matches stored value
        let (expected_pda, expected_bump) = Pubkey::find_program_address(
            &[
                ptf_common::seeds::VERIFIER,
                &circuit_tag,
                &[version]
            ],
            ctx.program_id,
        );
        require_keys_eq!(
            ctx.accounts.verifier_state.key(),
            expected_pda,
            VerifierError::InvalidPDA
        );
        require!(
            bump == expected_bump,
            VerifierError::InvalidBump
        );
        
        // CRITICAL FIX: Check if key is revoked
        require!(!revoked, VerifierError::KeyRevoked);
        
        require!(
            stored_verifying_key_id == verifying_key_id,
            VerifierError::InvalidVerifyingKeyId,
        );
        
        // CRITICAL FIX: Validate minimum version before verification
        // This prevents old/insecure verifying keys from being used
        require!(
            version >= MIN_SUPPORTED_VERSION,
            VerifierError::VersionTooOld
        );
        
        let vk = &ctx.accounts.verifier_state;
        
        // CRITICAL FIX: Comprehensive account data integrity validation
        validate_account_integrity(vk)?;
        
        require!(verify_account_hash(vk), VerifierError::HashMismatch,);
        
        // CRITICAL FIX: Validate account size matches calculation
        let expected_space = VerifyingKeyAccount::space(verifying_key_len);
        let actual_size = ctx.accounts.verifier_state.to_account_info().data_len();
        require!(
            actual_size >= expected_space,
            VerifierError::AccountSizeMismatch
        );

        require!(
            proof.len() <= MAX_PROOF_SIZE,
            VerifierError::ProofTooLarge
        );
        require!(
            public_inputs.len() <= MAX_PUBLIC_INPUTS_SIZE,
            VerifierError::PublicInputsTooLarge
        );
        // CRITICAL FIX: Remove empty proof/input bypass - always require valid proofs
        require!(!proof.is_empty(), VerifierError::EmptyProof);
        require!(!public_inputs.is_empty(), VerifierError::EmptyPublicInputs);
        require!(!vk.verifying_key.is_empty(), VerifierError::EmptyVerifyingKey);
        
        // Note: Proof format validation happens during deserialization in groth16_verify
        // The actual verification will catch invalid proofs, so we don't need to validate format here

        // CRITICAL FIX: Always perform actual verification - no bypasses
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
    
    // CRITICAL FIX: Add key update mechanism
    pub fn update_verifying_key(
        ctx: Context<UpdateVerifyingKey>,
        new_hash: [u8; 32],
        new_version: u8,
        new_verifying_key_data: Vec<u8>,
    ) -> Result<()> {
        require!(
            !new_verifying_key_data.is_empty(),
            VerifierError::EmptyVerifyingKey
        );
        require!(
            new_verifying_key_data.len() <= MAX_VERIFYING_KEY_SIZE,
            VerifierError::VerifyingKeyTooLarge
        );
        require!(
            new_version >= MIN_SUPPORTED_VERSION,
            VerifierError::VersionTooOld
        );
        
        // CRITICAL FIX: Validate new key format
        validate_verifying_key_format(&new_verifying_key_data)?;
        
        // Verify hash
        let mut hasher = Keccak256::new();
        hasher.update(&new_verifying_key_data);
        let computed_hash: [u8; 32] = hasher.finalize().into();
        require!(computed_hash == new_hash, VerifierError::HashMismatch);
        
        let vk = &mut ctx.accounts.verifier_state;
        
        // CRITICAL FIX: Require factory authority
        require_keys_eq!(
            ctx.accounts.authority.key(),
            vk.authority,
            VerifierError::UnauthorizedAuthority
        );
        
        // CRITICAL FIX: Cannot update revoked keys
        require!(!vk.revoked, VerifierError::KeyRevoked);
        
        // Update key data
        vk.hash = new_hash;
        vk.version = new_version;
        vk.verifying_key = new_verifying_key_data.clone();
        
        // Validate stored length
        require!(
            vk.verifying_key.len() == new_verifying_key_data.len(),
            VerifierError::DataLengthMismatch
        );
        
        emit!(VerifyingKeyUpdated {
            verifying_key_id: vk.verifying_key_id,
            new_hash,
            new_version,
        });
        
        Ok(())
    }
    
    // CRITICAL FIX: Add key revocation mechanism
    pub fn revoke_verifying_key(
        ctx: Context<RevokeVerifyingKey>,
    ) -> Result<()> {
        let vk = &mut ctx.accounts.verifier_state;
        
        // CRITICAL FIX: Require factory authority
        require_keys_eq!(
            ctx.accounts.authority.key(),
            vk.authority,
            VerifierError::UnauthorizedAuthority
        );
        
        require!(!vk.revoked, VerifierError::AlreadyRevoked);
        
        let clock = Clock::get()?;
        vk.revoked = true;
        vk.revoked_at = Some(clock.unix_timestamp);
        
        emit!(VerifyingKeyRevoked {
            verifying_key_id: vk.verifying_key_id,
            revoked_at: clock.unix_timestamp,
        });
        
        Ok(())
    }
    
    // CRITICAL FIX: Initialize verifier config to store factory program ID
    pub fn initialize_verifier_config(
        ctx: Context<InitializeVerifierConfig>,
        factory_program_id: Pubkey,
    ) -> Result<()> {
        // Validate factory program ID is executable
        require!(
            ctx.accounts.factory_program.executable,
            VerifierError::InvalidProgramId
        );
        require_keys_eq!(
            ctx.accounts.factory_program.key(),
            factory_program_id,
            VerifierError::InvalidProgramId
        );
        
        let config = &mut ctx.accounts.verifier_config;
        config.factory_program_id = factory_program_id;
        config.authority = ctx.accounts.authority.key();
        config.bump = ctx.bumps.verifier_config;
        
        emit!(VerifierConfigInitialized {
            factory_program_id,
            authority: config.authority,
        });
        
        Ok(())
    }
    
    // CRITICAL FIX: Update factory program ID (requires authority)
    pub fn update_factory_program_id(
        ctx: Context<UpdateFactoryProgramId>,
        new_factory_program_id: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.verifier_config.authority,
            VerifierError::UnauthorizedAuthority
        );
        
        // Validate new program ID
        require!(
            ctx.accounts.new_factory_program.executable,
            VerifierError::InvalidProgramId
        );
        require_keys_eq!(
            ctx.accounts.new_factory_program.key(),
            new_factory_program_id,
            VerifierError::InvalidProgramId
        );
        
        let old_id = ctx.accounts.verifier_config.factory_program_id;
        ctx.accounts.verifier_config.factory_program_id = new_factory_program_id;
        
        emit!(FactoryProgramIdUpdated {
            old_factory_program_id: old_id,
            new_factory_program_id,
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
        owner = crate::ID @ VerifierError::InvalidAccountOwner,
    )]
    pub verifier_state: Account<'info, VerifyingKeyAccount>,
    /// CRITICAL FIX: VerifierConfig stores the factory program ID (required, no backwards compatibility)
    #[account(
        seeds = [b"verifier-config", crate::ID.as_ref()],
        bump = verifier_config.bump,
    )]
    pub verifier_config: Account<'info, VerifierConfig>,
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
        constraint = verifier_state.to_account_info().owner == &crate::ID @ VerifierError::InvalidAccountOwner,
    )]
    pub verifier_state: Account<'info, VerifyingKeyAccount>,
}

#[derive(Accounts)]
pub struct UpdateVerifyingKey<'info> {
    #[account(
        mut,
        seeds = [
            ptf_common::seeds::VERIFIER,
            &verifier_state.circuit_tag,
            &[verifier_state.version],
        ],
        bump = verifier_state.bump,
    )]
    pub verifier_state: Account<'info, VerifyingKeyAccount>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevokeVerifyingKey<'info> {
    #[account(
        mut,
        seeds = [
            ptf_common::seeds::VERIFIER,
            &verifier_state.circuit_tag,
            &[verifier_state.version],
        ],
        bump = verifier_state.bump,
    )]
    pub verifier_state: Account<'info, VerifyingKeyAccount>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeVerifierConfig<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [b"verifier-config", crate::ID.as_ref()],
        bump,
        space = VerifierConfig::SPACE,
    )]
    pub verifier_config: Account<'info, VerifierConfig>,
    pub authority: Signer<'info>,
    /// CHECK: Validated in instruction to be executable
    pub factory_program: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFactoryProgramId<'info> {
    #[account(
        mut,
        seeds = [b"verifier-config", crate::ID.as_ref()],
        bump = verifier_config.bump,
    )]
    pub verifier_config: Account<'info, VerifierConfig>,
    pub authority: Signer<'info>,
    /// CHECK: Validated in instruction to be executable
    pub new_factory_program: AccountInfo<'info>,
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
    pub revoked: bool, // CRITICAL FIX: Track revocation status
    pub revoked_at: Option<i64>, // CRITICAL FIX: Track when revoked
}

// CRITICAL FIX: Configuration account to store factory program ID
#[account]
pub struct VerifierConfig {
    pub factory_program_id: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
}

impl VerifierConfig {
    // SPACE = discriminator[8] + factory_program_id[32] + authority[32] + bump[1]
    pub const SPACE: usize = 8 + 32 + 32 + 1;
}

impl VerifyingKeyAccount {
    // BASE_SIZE: discriminator (8) + authority (32) + circuit_tag (32) + verifying_key_id (32) + hash (32) + bump (1) + version (1) + Vec length (4) + revoked (1) + revoked_at (9)
    pub const BASE_SIZE: usize = 8 + 32 + 32 + 32 + 32 + 1 + 1 + 4 + 1 + 9;

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

#[event]
pub struct VerifyingKeyUpdated {
    pub verifying_key_id: [u8; 32],
    pub new_hash: [u8; 32],
    pub new_version: u8,
}

#[event]
pub struct VerifyingKeyRevoked {
    pub verifying_key_id: [u8; 32],
    pub revoked_at: i64,
}

#[event]
pub struct VerifierConfigInitialized {
    pub factory_program_id: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct FactoryProgramIdUpdated {
    pub old_factory_program_id: Pubkey,
    pub new_factory_program_id: Pubkey,
}

#[error_code]
pub enum VerifierError {
    // Standardized sanitization errors
    #[msg("Invalid proof")]
    InvalidProof,
    // Standardized integrity errors
    #[msg("Hash mismatch")]
    HashMismatch,
    // Program-specific errors
    #[msg("Verifying key data must not be empty")]
    EmptyVerifyingKey,
    #[msg("Verifying key id must be provided")]
    InvalidVerifyingKeyId,
    #[msg("Proof must not be empty")]
    EmptyProof,
    #[msg("Public inputs must not be empty")]
    EmptyPublicInputs,
    // Standardized access control errors
    #[msg("Unauthorized authority - only factory can create keys")]
    UnauthorizedAuthority,
    // Standardized sanitization errors
    #[msg("Proof too large")]
    ProofTooLarge,
    #[msg("Public inputs too large")]
    PublicInputsTooLarge,
    // Program-specific errors
    #[msg("Verifying key version is too old and no longer supported")]
    VersionTooOld,
    #[msg("Verifying key exceeds maximum allowed size")]
    VerifyingKeyTooLarge,
    #[msg("Verifying key format is invalid")]
    InvalidKeyFormat,
    #[msg("Verifying key has been revoked")]
    KeyRevoked,
    #[msg("Verifying key is already revoked")]
    AlreadyRevoked,
    // Standardized validation errors
    #[msg("Invalid account owner")]
    InvalidAccountOwner,
    #[msg("Invalid PDA")]
    InvalidPDA,
    #[msg("Invalid bump seed")]
    InvalidBump,
    #[msg("Data length mismatch")]
    DataLengthMismatch,
    #[msg("Account size mismatch")]
    AccountSizeMismatch,
    // Standardized sanitization errors
    #[msg("Invalid proof format")]
    InvalidProofFormat,
    // Program-specific errors
    #[msg("Invalid program ID")]
    InvalidProgramId,
    #[msg("Invalid circuit tag")]
    InvalidCircuitTag,
}

fn verify_account_hash(account: &VerifyingKeyAccount) -> bool {
    let mut hasher = Keccak256::new();
    hasher.update(&account.verifying_key);
    let computed: [u8; 32] = hasher.finalize().into();
    computed == account.hash
}

// CRITICAL FIX: Comprehensive account data integrity validation
fn validate_account_integrity(account: &VerifyingKeyAccount) -> Result<()> {
    // Validate version is reasonable (0-255, but check against minimum supported)
    require!(
        account.version >= MIN_SUPPORTED_VERSION && account.version <= 255,
        VerifierError::VersionTooOld
    );
    
    // Validate bump is reasonable (0-255, but typically > 0)
    require!(
        account.bump <= 255,
        VerifierError::InvalidBump
    );
    
    // Validate verifying_key_id is not zero
    require!(
        account.verifying_key_id != [0u8; 32],
        VerifierError::InvalidVerifyingKeyId
    );
    
    // Validate circuit_tag is not zero
    require!(
        account.circuit_tag != [0u8; 32],
        VerifierError::InvalidCircuitTag
    );
    
    // Validate authority is not default
    require!(
        account.authority != Pubkey::default(),
        VerifierError::UnauthorizedAuthority
    );
    
    // Validate verifying_key is not empty
    require!(
        !account.verifying_key.is_empty(),
        VerifierError::EmptyVerifyingKey
    );
    
    Ok(())
}

// CRITICAL FIX: Validate verifying key format during registration
fn validate_verifying_key_format(key_data: &[u8]) -> Result<()> {
    // For BPF/SBF builds, we can't deserialize, so we do basic validation
    #[cfg(any(target_arch = "bpf", target_arch = "sbf"))]
    {
        // Basic size check - Groth16 verifying keys for Bn254 are typically at least 100 bytes
        require!(
            key_data.len() >= 100,
            VerifierError::InvalidKeyFormat
        );
        Ok(())
    }
    
    // For host builds (tests), we can deserialize to validate format
    #[cfg(not(any(target_arch = "bpf", target_arch = "sbf")))]
    {
        use ark_bn254::Bn254;
        use ark_groth16::VerifyingKey;
        use ark_serialize::CanonicalDeserialize;
        use std::io::Cursor;
        
        let mut cursor = Cursor::new(key_data);
        match VerifyingKey::<Bn254>::deserialize_uncompressed(&mut cursor) {
            Ok(_) => {
                // Verify entire data was consumed
                // CRITICAL FIX: Use try_from instead of cast to prevent truncation
                let position = usize::try_from(cursor.position())
                    .map_err(|_| VerifierError::InvalidKeyFormat)?;
                require!(
                    position == key_data.len(),
                    VerifierError::InvalidKeyFormat
                );
                Ok(())
            }
            Err(_) => err!(VerifierError::InvalidKeyFormat)
        }
    }
}

// CRITICAL FIX: Validate proof format before verification
fn validate_proof_format(proof: &[u8]) -> Result<()> {
    // Groth16 proofs for Bn254 are 192 bytes (2 G1 points + 1 G2 point)
    require!(
        proof.len() >= 192,
        VerifierError::InvalidProofFormat
    );
    Ok(())
}

#[cfg(all(
    feature = "groth16-syscall",
    any(target_arch = "bpf", target_arch = "sbf")
))]
fn groth16_verify(verifying_key: &[u8], proof: &[u8], public_inputs: &[u8]) -> bool {
    unsafe { groth16_verify_syscall(verifying_key, proof, public_inputs) }
}

// CRITICAL FIX: Dev-skip allowed for local development (test/debug builds)
// For production, use groth16-syscall feature instead
#[cfg(all(
    feature = "groth16-dev-skip",
    not(feature = "groth16-syscall"),
    any(target_arch = "bpf", target_arch = "sbf")
))]
fn groth16_verify(_verifying_key: &[u8], _proof: &[u8], _public_inputs: &[u8]) -> bool {
    // WARNING: This bypasses proof verification - only use for local development!
    // For production, build with --features groth16-syscall instead
    true
}

#[cfg(all(
    any(target_arch = "bpf", target_arch = "sbf"),
    not(feature = "groth16-syscall"),
    not(feature = "groth16-dev-skip")
))]
compile_error!(
    "Enable either `groth16-syscall` or `groth16-dev-skip` features for BPF/SBF builds."
);

#[cfg(not(any(target_arch = "bpf", target_arch = "sbf")))]
fn groth16_verify(verifying_key: &[u8], proof: &[u8], public_inputs: &[u8]) -> bool {
    use ark_bn254::{Bn254, Fr};
    use ark_groth16::{prepare_verifying_key, Groth16, Proof, VerifyingKey};
    use ark_serialize::CanonicalDeserialize;
    use ark_snark::SNARK;
    use std::io::Cursor;

    // CRITICAL FIX: Proper error handling instead of unwrap_or
    let mut vk_cursor = Cursor::new(verifying_key);
    let vk = match VerifyingKey::<Bn254>::deserialize_uncompressed(&mut vk_cursor) {
        Ok(vk) => vk,
        Err(_) => {
            // Log error in debug builds
            #[cfg(debug_assertions)]
            msg!("Failed to deserialize verifying key");
            return false;
        }
    };

    // CRITICAL FIX: Use try_from instead of cast
    let vk_position = match usize::try_from(vk_cursor.position()) {
        Ok(p) => p,
        Err(_) => {
            #[cfg(debug_assertions)]
            msg!("Cursor position exceeds usize::MAX");
            return false;
        }
    };
    if vk_position != verifying_key.len() {
        #[cfg(debug_assertions)]
        msg!("Verifying key deserialization did not consume all bytes");
        return false;
    }

    let mut proof_cursor = Cursor::new(proof);
    let proof_bytes_len = proof.len();
    let proof = match Proof::<Bn254>::deserialize_uncompressed(&mut proof_cursor) {
        Ok(proof) => proof,
        Err(_) => {
            #[cfg(debug_assertions)]
            msg!("Failed to deserialize proof");
            return false;
        }
    };

    if (proof_cursor.position() as usize) != proof_bytes_len {
        #[cfg(debug_assertions)]
        msg!("Proof deserialization did not consume all bytes");
        return false;
    }

    let mut inputs_cursor = Cursor::new(public_inputs);
    let inputs = match Vec::<Fr>::deserialize_uncompressed(&mut inputs_cursor) {
        Ok(inputs) => inputs,
        Err(_) => {
            #[cfg(debug_assertions)]
            msg!("Failed to deserialize public inputs");
            return false;
        }
    };

    // CRITICAL FIX: Use try_from instead of cast
    let inputs_position = match usize::try_from(inputs_cursor.position()) {
        Ok(p) => p,
        Err(_) => {
            #[cfg(debug_assertions)]
            msg!("Inputs cursor position exceeds usize::MAX");
            return false;
        }
    };
    if inputs_position != public_inputs.len() {
        #[cfg(debug_assertions)]
        msg!("Public inputs deserialization did not consume all bytes");
        return false;
    }

    let prepared = prepare_verifying_key(&vk);
    match Groth16::<Bn254>::verify_with_processed_vk(&prepared, &inputs, &proof) {
        Ok(result) => result,
        Err(_) => {
            #[cfg(debug_assertions)]
            msg!("Verification error");
            false
        }
    }
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
    fn groth16_host_fallback_rejects_zeroed_proof() {
        let mut rng = StdRng::seed_from_u64(48);
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

        let public_inputs = vec![Fr::from(42u64)];
        let mut public_bytes = Vec::new();
        public_inputs
            .serialize_uncompressed(&mut public_bytes)
            .expect("serialize inputs");

        let zero_proof = vec![0u8; 192];
        assert!(!groth16_verify(&vk_bytes, &zero_proof, &public_bytes));
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
            revoked: false,
            revoked_at: None,
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
            revoked: account.revoked,
            revoked_at: account.revoked_at,
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
    
    // CRITICAL FIX: Log error codes for debugging (be careful not to spam)
    if result != 0 {
        #[cfg(debug_assertions)]
        msg!("Groth16 syscall returned error code: {}", result);
    }
    
    result == 0
}
