use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use ptf_common::{
    seeds, FeatureFlags, FEATURE_HOOKS_ENABLED, FEATURE_PRIVATE_TRANSFER_ENABLED, MAX_BPS,
};
use ptf_vault::program::PtfVault;
use ptf_vault::{self};
use ptf_verifier_groth16::program::PtfVerifierGroth16;
use ptf_verifier_groth16::{self, VerifyingKeyAccount};

declare_id!("ptfPool11111111111111111111111111111111111");

#[program]
pub mod ptf_pool {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16, features: u8) -> Result<()> {
        require!(fee_bps <= MAX_BPS, PoolError::InvalidFeeBps);

        let pool_state = &mut ctx.accounts.pool_state;
        require_keys_eq!(
            ctx.accounts.vault_state.origin_mint,
            ctx.accounts.origin_mint.key(),
            PoolError::OriginMintMismatch,
        );
        pool_state.origin_mint = ctx.accounts.vault_state.origin_mint;
        pool_state.vault = ctx.accounts.vault_state.key();
        pool_state.verifier_program = ctx.accounts.verifier_program.key();
        pool_state.verifying_key = ctx.accounts.verifying_key.key();
        pool_state.authority = ctx.accounts.authority.key();
        pool_state.fee_bps = fee_bps;
        pool_state.features = FeatureFlags::from(features);
        pool_state.bump = ctx.bumps.pool_state;
        pool_state.roots_len = 0;
        pool_state.current_root = [0u8; 32];
        pool_state.total_shielded = 0;
        pool_state.protocol_fees = 0;
        pool_state.hook_config = Pubkey::default();
        pool_state.hook_config_present = false;

        require_keys_eq!(
            ctx.accounts.vault_state.pool_authority,
            pool_state.key(),
            PoolError::MismatchedVaultAuthority,
        );

        let nulls = &mut ctx.accounts.nullifier_set;
        nulls.pool = pool_state.key();
        nulls.bump = ctx.bumps.nullifier_set;
        nulls.count = 0;

        emit!(PoolInitialized {
            origin_mint: pool_state.origin_mint,
            fee_bps,
            features,
        });
        Ok(())
    }

    pub fn set_fee(ctx: Context<UpdateAuthority>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_BPS, PoolError::InvalidFeeBps);
        ctx.accounts.pool_state.fee_bps = fee_bps;
        emit!(FeeUpdated {
            origin_mint: ctx.accounts.pool_state.origin_mint,
            fee_bps,
        });
        Ok(())
    }

    pub fn set_features(ctx: Context<UpdateAuthority>, features: u8) -> Result<()> {
        ctx.accounts.pool_state.features = FeatureFlags::from(features);
        emit!(FeaturesUpdated {
            origin_mint: ctx.accounts.pool_state.origin_mint,
            features,
        });
        Ok(())
    }

    pub fn set_hook_config(
        ctx: Context<UpdateAuthority>,
        hook_config: Pubkey,
        enabled: bool,
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        pool_state.hook_config = hook_config;
        pool_state.hook_config_present = enabled;
        Ok(())
    }

    pub fn shield(ctx: Context<Shield>, args: ShieldArgs) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        require_keys_eq!(
            ctx.accounts.verifier_program.key(),
            pool_state.verifier_program,
            PoolError::VerifierMismatch,
        );
        require_keys_eq!(
            ctx.accounts.verifying_key.key(),
            pool_state.verifying_key,
            PoolError::VerifierMismatch,
        );

        let cpi_accounts = ptf_verifier_groth16::cpi::accounts::VerifyGroth16 {
            verifier_state: ctx.accounts.verifying_key.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.verifier_program.to_account_info(),
            cpi_accounts,
        );
        ptf_verifier_groth16::cpi::verify_groth16(
            cpi_ctx,
            args.proof.clone(),
            args.public_inputs.clone(),
        )?;

        pool_state.push_root(args.new_root);
        pool_state.total_shielded = pool_state
            .total_shielded
            .checked_add(args.amount)
            .ok_or(PoolError::AmountOverflow)?;

        emit!(Shielded {
            origin_mint: pool_state.origin_mint,
            depositor: ctx.accounts.payer.key(),
            commitment: args.commitment,
            root: pool_state.current_root,
            amount_commit: args.amount_commit,
        });
        Ok(())
    }

    pub fn unshield_to_origin(ctx: Context<Unshield>, args: UnshieldArgs) -> Result<()> {
        process_unshield(ctx, args, UnshieldMode::Origin)
    }

    pub fn unshield_to_ptkn(ctx: Context<Unshield>, args: UnshieldArgs) -> Result<()> {
        let pool_state = &ctx.accounts.pool_state;
        require!(
            pool_state
                .features
                .contains(FeatureFlags::from(FEATURE_PRIVATE_TRANSFER_ENABLED)),
            PoolError::FeatureDisabled,
        );
        process_unshield(ctx, args, UnshieldMode::Twin)
    }

    pub fn accept_root(ctx: Context<UpdateAuthority>, root: [u8; 32]) -> Result<()> {
        ctx.accounts.pool_state.push_root(root);
        Ok(())
    }

    pub fn write_nullifier(ctx: Context<UpdateAuthority>, nullifier: [u8; 32]) -> Result<()> {
        ctx.accounts
            .nullifier_set
            .insert(nullifier)
            .map_err(|_| PoolError::NullifierReuse)?;
        Ok(())
    }
}

fn process_unshield(ctx: Context<Unshield>, args: UnshieldArgs, mode: UnshieldMode) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;
    require_keys_eq!(
        ctx.accounts.verifier_program.key(),
        pool_state.verifier_program,
        PoolError::VerifierMismatch,
    );
    require_keys_eq!(
        ctx.accounts.verifying_key.key(),
        pool_state.verifying_key,
        PoolError::VerifierMismatch,
    );

    require!(
        pool_state.is_known_root(&args.old_root),
        PoolError::UnknownRoot,
    );

    let cpi_accounts = ptf_verifier_groth16::cpi::accounts::VerifyGroth16 {
        verifier_state: ctx.accounts.verifying_key.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.verifier_program.to_account_info(),
        cpi_accounts,
    );
    ptf_verifier_groth16::cpi::verify_groth16(
        cpi_ctx,
        args.proof.clone(),
        args.public_inputs.clone(),
    )?;

    let fee = pool_state.calculate_fee(args.amount)?;
    let total_spent = args
        .amount
        .checked_add(fee)
        .ok_or(PoolError::AmountOverflow)?;
    require!(
        total_spent <= pool_state.total_shielded,
        PoolError::InsufficientLiquidity,
    );

    for nullifier in &args.nullifiers {
        ctx.accounts
            .nullifier_set
            .insert(*nullifier)
            .map_err(|_| PoolError::NullifierReuse)?;
    }

    pool_state.total_shielded = pool_state
        .total_shielded
        .checked_sub(total_spent)
        .ok_or(PoolError::AmountOverflow)?;
    pool_state.protocol_fees = pool_state
        .protocol_fees
        .checked_add(fee)
        .ok_or(PoolError::AmountOverflow)?;
    pool_state.push_root(args.new_root);

    let signer_seeds: [&[u8]; 3] = [
        seeds::POOL,
        pool_state.origin_mint.as_ref(),
        &[pool_state.bump],
    ];
    let cpi_accounts = ptf_vault::cpi::accounts::Release {
        vault_state: ctx.accounts.vault_state.to_account_info(),
        vault_token_account: ctx.accounts.vault_token_account.to_account_info(),
        destination_token_account: ctx.accounts.destination_token_account.to_account_info(),
        pool_authority: ctx.accounts.pool_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    let signer = &[&signer_seeds[..]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.vault_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    ptf_vault::cpi::release(cpi_ctx, args.amount)?;

    match mode {
        UnshieldMode::Origin => {
            emit!(UnshieldOrigin {
                origin_mint: pool_state.origin_mint,
                destination: ctx.accounts.destination_token_account.owner,
                amount: args.amount,
                fee,
            });
        }
        UnshieldMode::Twin => {
            emit!(UnshieldTwin {
                origin_mint: pool_state.origin_mint,
                destination: ctx.accounts.destination_token_account.owner,
                amount: args.amount,
                fee,
            });
        }
    }

    if pool_state
        .features
        .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED))
        && pool_state.hook_config_present
    {
        emit!(HookPostUnshield {
            origin_mint: pool_state.origin_mint,
            mode: mode as u8,
            destination: ctx.accounts.destination_token_account.owner,
            amount: args.amount,
        });
    }

    Ok(())
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::POOL, origin_mint.key().as_ref()],
        bump,
        space = PoolState::SPACE,
    )]
    pub pool_state: Account<'info, PoolState>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::NULLIFIERS, origin_mint.key().as_ref()],
        bump,
        space = NullifierSet::SPACE,
    )]
    pub nullifier_set: Account<'info, NullifierSet>,
    #[account(mut)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    /// CHECK: Seed used for PDA derivation.
    pub origin_mint: AccountInfo<'info>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::POOL, pool_state.origin_mint.as_ref()], bump = pool_state.bump, has_one = authority)]
    pub pool_state: Account<'info, PoolState>,
    #[account(mut, seeds = [seeds::NULLIFIERS, pool_state.origin_mint.as_ref()], bump = nullifier_set.bump)]
    pub nullifier_set: Account<'info, NullifierSet>,
}

#[derive(Accounts)]
pub struct Shield<'info> {
    #[account(mut, seeds = [seeds::POOL, pool_state.origin_mint.as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,
    #[account(mut, seeds = [seeds::NULLIFIERS, pool_state.origin_mint.as_ref()], bump = nullifier_set.bump)]
    pub nullifier_set: Account<'info, NullifierSet>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(address = pool_state.verifying_key)]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Unshield<'info> {
    #[account(mut, seeds = [seeds::POOL, pool_state.origin_mint.as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,
    #[account(mut, seeds = [seeds::NULLIFIERS, pool_state.origin_mint.as_ref()], bump = nullifier_set.bump)]
    pub nullifier_set: Account<'info, NullifierSet>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(address = pool_state.verifying_key)]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    #[account(mut)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,
    pub vault_program: Program<'info, PtfVault>,
    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ShieldArgs {
    pub new_root: [u8; 32],
    pub commitment: [u8; 32],
    pub amount_commit: [u8; 32],
    pub amount: u64,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnshieldArgs {
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub nullifiers: Vec<[u8; 32]>,
    pub amount: u64,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
}

#[account]
pub struct PoolState {
    pub authority: Pubkey,
    pub origin_mint: Pubkey,
    pub vault: Pubkey,
    pub verifier_program: Pubkey,
    pub verifying_key: Pubkey,
    pub current_root: [u8; 32],
    pub recent_roots: [[u8; 32]; Self::MAX_ROOTS],
    pub roots_len: u8,
    pub fee_bps: u16,
    pub features: FeatureFlags,
    pub total_shielded: u64,
    pub protocol_fees: u64,
    pub hook_config: Pubkey,
    pub hook_config_present: bool,
    pub bump: u8,
}

impl PoolState {
    pub const MAX_ROOTS: usize = 16;
    pub const SPACE: usize =
        8 + 32 + 32 + 32 + 32 + 32 + (Self::MAX_ROOTS * 32) + 1 + 2 + 1 + 8 + 8 + 32 + 1 + 1 + 8;

    pub fn push_root(&mut self, root: [u8; 32]) {
        if self.roots_len as usize >= Self::MAX_ROOTS {
            for idx in 1..Self::MAX_ROOTS {
                self.recent_roots[idx - 1] = self.recent_roots[idx];
            }
            self.recent_roots[Self::MAX_ROOTS - 1] = root;
            self.current_root = root;
        } else {
            self.recent_roots[self.roots_len as usize] = root;
            self.roots_len += 1;
            self.current_root = root;
        }
    }

    pub fn is_known_root(&self, candidate: &[u8; 32]) -> bool {
        if &self.current_root == candidate {
            return true;
        }
        for idx in 0..self.roots_len as usize {
            if &self.recent_roots[idx] == candidate {
                return true;
            }
        }
        false
    }

    pub fn calculate_fee(&self, amount: u64) -> Result<u64> {
        let fee = (amount as u128)
            .checked_mul(self.fee_bps as u128)
            .ok_or(PoolError::AmountOverflow)?
            / 10_000u128;
        Ok(fee as u64)
    }
}

#[account]
pub struct NullifierSet {
    pub pool: Pubkey,
    pub count: u32,
    pub entries: [[u8; 32]; Self::MAX_NULLIFIERS],
    pub bump: u8,
}

impl NullifierSet {
    pub const MAX_NULLIFIERS: usize = 256;
    pub const SPACE: usize = 8 + 32 + 4 + (Self::MAX_NULLIFIERS * 32) + 1 + 3;

    pub fn insert(&mut self, value: [u8; 32]) -> Result<()> {
        for idx in 0..self.count as usize {
            if self.entries[idx] == value {
                return err!(PoolError::NullifierReuse);
            }
        }
        require!(
            (self.count as usize) < Self::MAX_NULLIFIERS,
            PoolError::NullifierCapacity,
        );
        self.entries[self.count as usize] = value;
        self.count += 1;
        Ok(())
    }
}

#[event]
pub struct PoolInitialized {
    pub origin_mint: Pubkey,
    pub fee_bps: u16,
    pub features: u8,
}

#[event]
pub struct Shielded {
    pub origin_mint: Pubkey,
    pub depositor: Pubkey,
    pub commitment: [u8; 32],
    pub root: [u8; 32],
    pub amount_commit: [u8; 32],
}

#[event]
pub struct UnshieldOrigin {
    pub origin_mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct UnshieldTwin {
    pub origin_mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct HookPostUnshield {
    pub origin_mint: Pubkey,
    pub mode: u8,
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FeeUpdated {
    pub origin_mint: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct FeaturesUpdated {
    pub origin_mint: Pubkey,
    pub features: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum UnshieldMode {
    Origin = 0,
    Twin = 1,
}

#[error_code]
pub enum PoolError {
    #[msg("invalid fee basis points")]
    InvalidFeeBps,
    #[msg("verifier mismatch")]
    VerifierMismatch,
    #[msg("unknown root")]
    UnknownRoot,
    #[msg("nullifier already used")]
    NullifierReuse,
    #[msg("nullifier capacity reached")]
    NullifierCapacity,
    #[msg("arithmetic overflow")]
    AmountOverflow,
    #[msg("insufficient shielded balance")]
    InsufficientLiquidity,
    #[msg("feature disabled")]
    FeatureDisabled,
    #[msg("vault authority mismatch")]
    MismatchedVaultAuthority,
    #[msg("origin mint mismatch")]
    OriginMintMismatch,
}
