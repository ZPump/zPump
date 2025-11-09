use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use ptf_common::{seeds, FeatureFlags, MAX_BPS};

declare_id!("4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy");

#[program]
pub mod ptf_factory {
    use super::*;

    pub fn initialize_factory(
        ctx: Context<InitializeFactory>,
        authority: Pubkey,
        default_fee_bps: u16,
        timelock_seconds: i64,
    ) -> Result<()> {
        require!(default_fee_bps <= MAX_BPS, FactoryError::InvalidFeeBps);

        let state = &mut ctx.accounts.factory_state;
        state.authority = authority;
        state.default_fee_bps = default_fee_bps;
        state.default_features = FeatureFlags::empty();
        state.paused = false;
        state.timelock_seconds = timelock_seconds;
        state.bump = ctx.bumps.factory_state;
        state.last_updated_slot = Clock::get()?.slot;

        emit!(FactoryInitialized {
            authority,
            default_fee_bps,
            timelock_seconds,
        });
        Ok(())
    }

    pub fn set_default_features(
        ctx: Context<UpdateFactoryAuthority>,
        default_features: u8,
    ) -> Result<()> {
        let state = &mut ctx.accounts.factory_state;
        state.default_features = FeatureFlags::from(default_features);
        state.last_updated_slot = Clock::get()?.slot;
        emit!(DefaultFeaturesUpdated {
            authority: ctx.accounts.authority.key(),
            features: default_features,
        });
        Ok(())
    }

    pub fn register_mint(
        ctx: Context<RegisterMint>,
        decimals: u8,
        enable_ptkn: bool,
        feature_flags: Option<u8>,
        fee_bps_override: Option<u16>,
    ) -> Result<()> {
        let state = &mut ctx.accounts.factory_state;
        require!(!state.paused, FactoryError::Paused);
        require!(decimals <= 12, FactoryError::InvalidDecimals);
        if let Some(fee) = fee_bps_override {
            require!(fee <= MAX_BPS, FactoryError::InvalidFeeBps);
        }

        let mapping = &mut ctx.accounts.mint_mapping;
        mapping.origin_mint = ctx.accounts.origin_mint.key();
        mapping.status = MintStatus::Active as u8;
        mapping.decimals = decimals;
        mapping.features =
            FeatureFlags::from(feature_flags.unwrap_or_else(|| state.default_features.bits()));
        mapping.has_fee_override = fee_bps_override.is_some();
        mapping.fee_bps_override = fee_bps_override.unwrap_or_default();
        mapping.bump = ctx.bumps.mint_mapping;
        mapping.has_ptkn = false;
        mapping.ptkn_mint = Pubkey::default();

        let effective_fee_bps = fee_bps_override.unwrap_or(state.default_fee_bps);

        if enable_ptkn {
            let ptkn_mint = ctx
                .accounts
                .ptkn_mint
                .as_ref()
                .ok_or(FactoryError::PtknMintMissing)?;
            require!(
                ptkn_mint.decimals == decimals,
                FactoryError::InvalidDecimals
            );
            mapping.has_ptkn = true;
            mapping.ptkn_mint = ptkn_mint.key();
        }

        emit!(MintRegistered {
            origin_mint: ctx.accounts.origin_mint.key(),
            ptkn_mint: mapping.ptkn_mint,
            decimals,
            features: mapping.features.bits(),
            fee_bps: effective_fee_bps,
        });
        Ok(())
    }

    pub fn update_mint(ctx: Context<UpdateMint>, params: UpdateMintParams) -> Result<()> {
        let mapping = &mut ctx.accounts.mint_mapping;
        let state = &ctx.accounts.factory_state;
        require!(!state.paused, FactoryError::Paused);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            state.authority,
            FactoryError::Unauthorized
        );

        if let Some(fee) = params.fee_bps_override {
            require!(fee <= MAX_BPS, FactoryError::InvalidFeeBps);
            mapping.fee_bps_override = fee;
            mapping.has_fee_override = true;
        }

        if let Some(features) = params.features {
            mapping.features = FeatureFlags::from(features);
        }

        if let Some(enable_ptkn) = params.enable_ptkn {
            if enable_ptkn && !mapping.has_ptkn {
                let ptkn_mint = ctx
                    .accounts
                    .ptkn_mint
                    .as_ref()
                    .ok_or(FactoryError::PtknMintMissing)?;
                require!(
                    ptkn_mint.decimals == mapping.decimals,
                    FactoryError::InvalidDecimals
                );
                mapping.has_ptkn = true;
                mapping.ptkn_mint = ptkn_mint.key();
            } else if !enable_ptkn {
                mapping.has_ptkn = false;
                mapping.ptkn_mint = Pubkey::default();
            }
        }

        emit!(MintUpdated {
            origin_mint: mapping.origin_mint,
            ptkn_mint: mapping.ptkn_mint,
            features: mapping.features.bits(),
            fee_bps_override: if mapping.has_fee_override {
                Some(mapping.fee_bps_override)
            } else {
                None
            },
        });
        Ok(())
    }

    pub fn freeze_mapping(ctx: Context<MutationMintState>) -> Result<()> {
        let mapping = &mut ctx.accounts.mint_mapping;
        mapping.status = MintStatus::Frozen as u8;
        emit!(MintFrozen {
            origin_mint: mapping.origin_mint,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn thaw_mapping(ctx: Context<MutationMintState>) -> Result<()> {
        let mapping = &mut ctx.accounts.mint_mapping;
        mapping.status = MintStatus::Active as u8;
        emit!(MintThawed {
            origin_mint: mapping.origin_mint,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn pause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
        let state = &mut ctx.accounts.factory_state;
        state.paused = true;
        emit!(FactoryPaused {
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn unpause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
        let state = &mut ctx.accounts.factory_state;
        state.paused = false;
        emit!(FactoryUnpaused {
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeFactory<'info> {
    #[account(
        init,
        seeds = [seeds::FACTORY, crate::ID.as_ref()],
        bump,
        payer = payer,
        space = FactoryState::SPACE,
    )]
    pub factory_state: Account<'info, FactoryState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFactoryAuthority<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterMint<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::MINT_MAPPING, origin_mint.key().as_ref()],
        bump,
        space = MintMapping::SPACE,
    )]
    pub mint_mapping: Account<'info, MintMapping>,
    /// CHECK: The factory only records the origin mint address.
    pub origin_mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub ptkn_mint: Option<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMint<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::MINT_MAPPING, mint_mapping.origin_mint.as_ref()], bump = mint_mapping.bump)]
    pub mint_mapping: Account<'info, MintMapping>,
    #[account(mut)]
    pub ptkn_mint: Option<Account<'info, Mint>>,
}

#[derive(Accounts)]
pub struct MutationMintState<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::MINT_MAPPING, mint_mapping.origin_mint.as_ref()], bump = mint_mapping.bump)]
    pub mint_mapping: Account<'info, MintMapping>,
}

#[account]
pub struct FactoryState {
    pub authority: Pubkey,
    pub default_fee_bps: u16,
    pub default_features: FeatureFlags,
    pub paused: bool,
    pub timelock_seconds: i64,
    pub bump: u8,
    pub last_updated_slot: u64,
}

impl FactoryState {
    pub const SPACE: usize = 8 + 32 + 2 + 1 + 1 + 8 + 1 + 8;
}

#[account]
pub struct MintMapping {
    pub origin_mint: Pubkey,
    pub ptkn_mint: Pubkey,
    pub has_ptkn: bool,
    pub status: u8,
    pub decimals: u8,
    pub features: FeatureFlags,
    pub fee_bps_override: u16,
    pub has_fee_override: bool,
    pub bump: u8,
}

impl MintMapping {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 1 + 1 + 2 + 1 + 1 + 4;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateMintParams {
    pub enable_ptkn: Option<bool>,
    pub features: Option<u8>,
    pub fee_bps_override: Option<u16>,
}

#[event]
pub struct FactoryInitialized {
    pub authority: Pubkey,
    pub default_fee_bps: u16,
    pub timelock_seconds: i64,
}

#[event]
pub struct DefaultFeaturesUpdated {
    pub authority: Pubkey,
    pub features: u8,
}

#[event]
pub struct MintRegistered {
    pub origin_mint: Pubkey,
    pub ptkn_mint: Pubkey,
    pub decimals: u8,
    pub features: u8,
    pub fee_bps: u16,
}

#[event]
pub struct MintUpdated {
    pub origin_mint: Pubkey,
    pub ptkn_mint: Pubkey,
    pub features: u8,
    pub fee_bps_override: Option<u16>,
}

#[event]
pub struct MintFrozen {
    pub origin_mint: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct MintThawed {
    pub origin_mint: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct FactoryPaused {
    pub authority: Pubkey,
}

#[event]
pub struct FactoryUnpaused {
    pub authority: Pubkey,
}

#[repr(u8)]
pub enum MintStatus {
    Active = 1,
    Frozen = 2,
}

#[error_code]
pub enum FactoryError {
    #[msg("mint mapping already exists")]
    AlreadyRegistered,
    #[msg("factory is paused")]
    Paused,
    #[msg("privacy twin mint must be provided")]
    PtknMintMissing,
    #[msg("invalid fee basis points")]
    InvalidFeeBps,
    #[msg("caller not authorized")]
    Unauthorized,
    #[msg("invalid decimals for mint")]
    InvalidDecimals,
}
