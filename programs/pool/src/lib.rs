use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount};
use core::convert::TryFrom;

use ptf_common::{
    seeds, FeatureFlags, FEATURE_HOOKS_ENABLED, FEATURE_PRIVATE_TRANSFER_ENABLED, MAX_BPS,
};
use ptf_factory::MintMapping;
use ptf_vault::program::PtfVault;
use ptf_vault::{self};
use ptf_verifier_groth16::program::PtfVerifierGroth16;
use ptf_verifier_groth16::{self, VerifyingKeyAccount};

declare_id!("4Tx3v6is7qeVjdHvL3a16ggB9VVMBPVhpPSkUGoXZhre");

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
        require_keys_eq!(
            ctx.accounts.mint_mapping.origin_mint,
            ctx.accounts.origin_mint.key(),
            PoolError::OriginMintMismatch,
        );
        pool_state.origin_mint = ctx.accounts.vault_state.origin_mint;
        pool_state.vault = ctx.accounts.vault_state.key();
        pool_state.verifier_program = ctx.accounts.verifier_program.key();
        pool_state.verifying_key = ctx.accounts.verifying_key.key();
        pool_state.verifying_key_id = ctx.accounts.verifying_key.verifying_key_id;
        pool_state.authority = ctx.accounts.authority.key();
        pool_state.fee_bps = fee_bps;
        pool_state.features = FeatureFlags::from(features);
        pool_state.bump = ctx.bumps.pool_state;
        pool_state.roots_len = 0;
        pool_state.current_root = [0u8; 32];
        pool_state.total_shielded = 0;
        pool_state.protocol_fees = 0;
        pool_state.hook_config = ctx.accounts.hook_config.key();
        pool_state.hook_config_present = false;
        pool_state.hook_config_bump = ctx.bumps.hook_config;

        let hook_config = &mut ctx.accounts.hook_config;
        hook_config.pool = pool_state.key();
        hook_config.post_shield_program_id = Pubkey::default();
        hook_config.post_unshield_program_id = Pubkey::default();
        hook_config.required_accounts = [[0u8; 32]; HookConfig::MAX_REQUIRED_ACCOUNTS];
        hook_config.required_accounts_len = 0;
        hook_config.mode = HookAccountMode::Strict;
        hook_config.bump = ctx.bumps.hook_config;

        if ctx.accounts.mint_mapping.has_ptkn {
            let twin_mint = ctx
                .accounts
                .twin_mint
                .as_ref()
                .ok_or(PoolError::TwinMintNotConfigured)?;
            require_keys_eq!(
                twin_mint.key(),
                ctx.accounts.mint_mapping.ptkn_mint,
                PoolError::TwinMintMismatch,
            );
            require!(
                twin_mint.decimals == ctx.accounts.origin_mint.decimals,
                PoolError::TwinMintDecimalsMismatch,
            );
            match twin_mint.mint_authority {
                COption::Some(authority) => {
                    require_keys_eq!(
                        authority,
                        ctx.accounts.authority.key(),
                        PoolError::TwinMintAuthorityMismatch,
                    );
                }
                COption::None => return err!(PoolError::TwinMintAuthorityMismatch),
            }

            let cpi_accounts = SetAuthority {
                account_or_mint: twin_mint.to_account_info(),
                current_authority: ctx.accounts.authority.to_account_info(),
            };
            let cpi_ctx =
                CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token::set_authority(cpi_ctx, AuthorityType::MintTokens, Some(pool_state.key()))?;
            pool_state.twin_mint = twin_mint.key();
            pool_state.twin_mint_enabled = true;
        } else {
            require!(
                ctx.accounts.twin_mint.is_none(),
                PoolError::TwinMintMismatch,
            );
            pool_state.twin_mint = Pubkey::default();
            pool_state.twin_mint_enabled = false;
        }

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

    pub fn configure_hooks(ctx: Context<ConfigureHooks>, args: HookConfigArgs) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        require!(
            pool_state
                .features
                .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED)),
            PoolError::HooksDisabled,
        );

        let hook_config = &mut ctx.accounts.hook_config;
        hook_config.pool = pool_state.key();
        hook_config.post_shield_program_id = args.post_shield_program;
        hook_config.post_unshield_program_id = args.post_unshield_program;
        hook_config.mode = args.mode;
        hook_config.required_accounts_len = 0;
        hook_config.required_accounts = [[0u8; 32]; HookConfig::MAX_REQUIRED_ACCOUNTS];
        for (idx, key) in args.required_accounts.iter().enumerate() {
            require!(
                idx < HookConfig::MAX_REQUIRED_ACCOUNTS,
                PoolError::TooManyHookAccounts
            );
            hook_config.required_accounts[idx] = key.to_bytes();
            hook_config.required_accounts_len += 1;
        }

        pool_state.hook_config = hook_config.key();
        if args.post_shield_program == Pubkey::default()
            && args.post_unshield_program == Pubkey::default()
        {
            pool_state.hook_config_present = false;
        } else {
            pool_state.hook_config_present = true;
        }

        emit!(HookConfigUpdated {
            origin_mint: pool_state.origin_mint,
            post_shield_program: args.post_shield_program,
            post_unshield_program: args.post_unshield_program,
            mode: args.mode as u8,
        });
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
        require!(
            ctx.accounts.verifying_key.verifying_key_id == pool_state.verifying_key_id,
            PoolError::VerifierMismatch,
        );
        require_keys_eq!(
            ctx.accounts.vault_state.key(),
            pool_state.vault,
            PoolError::MismatchedVaultAuthority,
        );
        require_keys_eq!(
            ctx.accounts.vault_state.pool_authority,
            pool_state.key(),
            PoolError::MismatchedVaultAuthority,
        );
        require_keys_eq!(
            ctx.accounts.vault_token_account.owner,
            pool_state.vault,
            PoolError::VaultTokenAccountMismatch,
        );
        require_keys_eq!(
            ctx.accounts.vault_token_account.mint,
            pool_state.origin_mint,
            PoolError::OriginMintMismatch,
        );
        require_keys_eq!(
            ctx.accounts.origin_mint.key(),
            pool_state.origin_mint,
            PoolError::OriginMintMismatch,
        );
        require_keys_eq!(
            ctx.accounts.depositor_token_account.owner,
            ctx.accounts.payer.key(),
            PoolError::InvalidDepositorAccount,
        );
        require_keys_eq!(
            ctx.accounts.depositor_token_account.mint,
            pool_state.origin_mint,
            PoolError::OriginMintMismatch,
        );

        if pool_state.twin_mint_enabled {
            let twin_mint = ctx
                .accounts
                .twin_mint
                .as_ref()
                .ok_or(PoolError::TwinMintNotConfigured)?;
            require_keys_eq!(
                twin_mint.key(),
                pool_state.twin_mint,
                PoolError::TwinMintMismatch,
            );
        }

        let cpi_accounts = ptf_verifier_groth16::cpi::accounts::VerifyGroth16 {
            verifier_state: ctx.accounts.verifying_key.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.verifier_program.to_account_info(),
            cpi_accounts,
        );
        ptf_verifier_groth16::cpi::verify_groth16(
            cpi_ctx,
            pool_state.verifying_key_id,
            args.proof.clone(),
            args.public_inputs.clone(),
        )?;

        let deposit_accounts = ptf_vault::cpi::accounts::Deposit {
            vault_state: ctx.accounts.vault_state.to_account_info(),
            vault_token_account: ctx.accounts.vault_token_account.to_account_info(),
            origin_mint: ctx.accounts.origin_mint.to_account_info(),
            depositor: ctx.accounts.payer.to_account_info(),
            depositor_token_account: ctx.accounts.depositor_token_account.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        let deposit_ctx = CpiContext::new(
            ctx.accounts.vault_program.to_account_info(),
            deposit_accounts,
        );
        ptf_vault::cpi::deposit(deposit_ctx, args.amount)?;

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

        if pool_state
            .features
            .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED))
            && pool_state.hook_config_present
        {
            emit!(HookPostShield {
                origin_mint: pool_state.origin_mint,
                commitment: args.commitment,
            });
        }

        enforce_supply_invariant(
            pool_state,
            &ctx.accounts.vault_token_account,
            ctx.accounts.twin_mint.as_ref(),
        )?;
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

    pub fn private_transfer(ctx: Context<PrivateTransfer>, args: TransferArgs) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        require!(
            pool_state
                .features
                .contains(FeatureFlags::from(FEATURE_PRIVATE_TRANSFER_ENABLED)),
            PoolError::FeatureDisabled,
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
            pool_state.verifying_key_id,
            args.proof.clone(),
            args.public_inputs.clone(),
        )?;

        for nullifier in &args.nullifiers {
            ctx.accounts
                .nullifier_set
                .insert(*nullifier)
                .map_err(|_| PoolError::NullifierReuse)?;
        }

        pool_state.push_root(args.new_root);

        emit!(Transferred {
            origin_mint: pool_state.origin_mint,
            nullifiers: args.nullifiers.clone(),
            new_root: args.new_root,
        });
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
        ctx.accounts.verifying_key.verifying_key_id == pool_state.verifying_key_id,
        PoolError::VerifierMismatch,
    );
    require_keys_eq!(
        ctx.accounts.vault_state.key(),
        pool_state.vault,
        PoolError::MismatchedVaultAuthority,
    );
    require_keys_eq!(
        ctx.accounts.vault_state.pool_authority,
        pool_state.key(),
        PoolError::MismatchedVaultAuthority,
    );
    require_keys_eq!(
        ctx.accounts.vault_state.origin_mint,
        pool_state.origin_mint,
        PoolError::OriginMintMismatch,
    );
    require_keys_eq!(
        ctx.accounts.vault_token_account.owner,
        pool_state.vault,
        PoolError::VaultTokenAccountMismatch,
    );
    require_keys_eq!(
        ctx.accounts.vault_token_account.mint,
        pool_state.origin_mint,
        PoolError::OriginMintMismatch,
    );

    if pool_state.twin_mint_enabled {
        let twin_mint = ctx
            .accounts
            .twin_mint
            .as_ref()
            .ok_or(PoolError::TwinMintNotConfigured)?;
        require_keys_eq!(
            twin_mint.key(),
            pool_state.twin_mint,
            PoolError::TwinMintMismatch,
        );
    }

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
        pool_state.verifying_key_id,
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

    match mode {
        UnshieldMode::Origin => {
            require_keys_eq!(
                ctx.accounts.destination_token_account.mint,
                pool_state.origin_mint,
                PoolError::OriginMintMismatch,
            );
            let signer_seeds: [&[u8]; 3] = [
                seeds::POOL,
                pool_state.origin_mint.as_ref(),
                &[pool_state.bump],
            ];
            let cpi_accounts = ptf_vault::cpi::accounts::Release {
                vault_state: ctx.accounts.vault_state.to_account_info(),
                vault_token_account: ctx.accounts.vault_token_account.to_account_info(),
                destination_token_account: ctx.accounts.destination_token_account.to_account_info(),
                pool_authority: pool_state.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            let signer = &[&signer_seeds[..]];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.vault_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            ptf_vault::cpi::release(cpi_ctx, args.amount)?;
            emit!(UnshieldOrigin {
                origin_mint: pool_state.origin_mint,
                destination: ctx.accounts.destination_token_account.owner,
                amount: args.amount,
                fee,
            });
        }
        UnshieldMode::Twin => {
            require!(
                pool_state.twin_mint_enabled,
                PoolError::TwinMintNotConfigured
            );
            let twin_mint = ctx
                .accounts
                .twin_mint
                .as_ref()
                .ok_or(PoolError::TwinMintNotConfigured)?;
            require_keys_eq!(
                ctx.accounts.destination_token_account.mint,
                pool_state.twin_mint,
                PoolError::TwinMintMismatch,
            );
            let signer_seeds: [&[u8]; 3] = [
                seeds::POOL,
                pool_state.origin_mint.as_ref(),
                &[pool_state.bump],
            ];
            let mint_accounts = MintTo {
                mint: twin_mint.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: pool_state.to_account_info(),
            };
            let signer = &[&signer_seeds[..]];
            let mint_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                mint_accounts,
                signer,
            );
            token::mint_to(mint_ctx, args.amount)?;
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

    enforce_supply_invariant(
        pool_state,
        &ctx.accounts.vault_token_account,
        ctx.accounts.twin_mint.as_ref(),
    )
}

fn enforce_supply_invariant(
    pool_state: &PoolState,
    vault_token_account: &TokenAccount,
    twin_mint: Option<&Account<Mint>>,
) -> Result<()> {
    let vault_balance = u128::from(vault_token_account.amount);
    let twin_supply = match (pool_state.twin_mint_enabled, twin_mint) {
        (true, Some(mint)) => {
            require_keys_eq!(
                mint.key(),
                pool_state.twin_mint,
                PoolError::TwinMintMismatch
            );
            u128::from(mint.supply)
        }
        (true, None) => return err!(PoolError::TwinMintNotConfigured),
        (false, Some(_)) => return err!(PoolError::TwinMintMismatch),
        (false, None) => 0u128,
    };

    let expected = twin_supply
        .checked_add(u128::from(pool_state.total_shielded))
        .ok_or(PoolError::AmountOverflow)?
        .checked_add(u128::from(pool_state.protocol_fees))
        .ok_or(PoolError::AmountOverflow)?;

    require!(vault_balance == expected, PoolError::InvariantBreach);

    let supply_ptkn = u64::try_from(twin_supply).map_err(|_| PoolError::AmountOverflow)?;
    emit!(InvariantOk {
        origin_mint: pool_state.origin_mint,
        vault: pool_state.vault,
        supply_ptkn,
        live_notes: pool_state.total_shielded,
        protocol_fees: pool_state.protocol_fees,
    });

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
    #[account(
        init,
        payer = payer,
        seeds = [seeds::HOOKS, origin_mint.key().as_ref()],
        bump,
        space = HookConfig::SPACE,
    )]
    pub hook_config: Account<'info, HookConfig>,
    #[account(mut)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    pub origin_mint: Account<'info, Mint>,
    #[account(
        seeds = [seeds::MINT_MAPPING, origin_mint.key().as_ref()],
        bump = mint_mapping.bump
    )]
    pub mint_mapping: Account<'info, MintMapping>,
    #[account(mut)]
    pub twin_mint: Option<Account<'info, Mint>>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
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
    #[account(mut, seeds = [seeds::VAULT, pool_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub twin_mint: Option<Account<'info, Mint>>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(address = pool_state.verifying_key)]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    pub payer: Signer<'info>,
    pub origin_mint: Account<'info, Mint>,
    pub vault_program: Program<'info, PtfVault>,
    pub token_program: Program<'info, Token>,
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
    #[account(mut)]
    pub twin_mint: Option<Account<'info, Mint>>,
    pub vault_program: Program<'info, PtfVault>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ConfigureHooks<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::POOL, pool_state.origin_mint.as_ref()], bump = pool_state.bump, has_one = authority)]
    pub pool_state: Account<'info, PoolState>,
    #[account(
        mut,
        seeds = [seeds::HOOKS, pool_state.origin_mint.as_ref()],
        bump = pool_state.hook_config_bump,
    )]
    pub hook_config: Account<'info, HookConfig>,
}

#[derive(Accounts)]
pub struct PrivateTransfer<'info> {
    #[account(mut, seeds = [seeds::POOL, pool_state.origin_mint.as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,
    #[account(mut, seeds = [seeds::NULLIFIERS, pool_state.origin_mint.as_ref()], bump = nullifier_set.bump)]
    pub nullifier_set: Account<'info, NullifierSet>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(address = pool_state.verifying_key)]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransferArgs {
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub nullifiers: Vec<[u8; 32]>,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct HookConfigArgs {
    pub post_shield_program: Pubkey,
    pub post_unshield_program: Pubkey,
    pub required_accounts: Vec<Pubkey>,
    pub mode: HookAccountMode,
}

#[account]
pub struct PoolState {
    pub authority: Pubkey,
    pub origin_mint: Pubkey,
    pub vault: Pubkey,
    pub verifier_program: Pubkey,
    pub verifying_key: Pubkey,
    pub verifying_key_id: [u8; 32],
    pub current_root: [u8; 32],
    pub recent_roots: [[u8; 32]; Self::MAX_ROOTS],
    pub roots_len: u8,
    pub fee_bps: u16,
    pub features: FeatureFlags,
    pub total_shielded: u64,
    pub protocol_fees: u64,
    pub hook_config: Pubkey,
    pub hook_config_present: bool,
    pub hook_config_bump: u8,
    pub bump: u8,
    pub twin_mint: Pubkey,
    pub twin_mint_enabled: bool,
}

impl PoolState {
    pub const MAX_ROOTS: usize = 16;
    pub const SPACE: usize =
        8 + (32 * 7) + 32 + 32 + (Self::MAX_ROOTS * 32) + 1 + 2 + 1 + 8 + 8 + 1 + 1 + 1 + 1 + 7;

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

#[account]
pub struct HookConfig {
    pub pool: Pubkey,
    pub post_shield_program_id: Pubkey,
    pub post_unshield_program_id: Pubkey,
    pub required_accounts: [[u8; 32]; Self::MAX_REQUIRED_ACCOUNTS],
    pub required_accounts_len: u8,
    pub mode: HookAccountMode,
    pub bump: u8,
}

impl HookConfig {
    pub const MAX_REQUIRED_ACCOUNTS: usize = 8;
    pub const SPACE: usize = 8 + 32 + 32 + 32 + (Self::MAX_REQUIRED_ACCOUNTS * 32) + 1 + 1 + 1 + 6;

    pub fn required_keys(&self) -> impl Iterator<Item = Pubkey> + '_ {
        self.required_accounts
            .iter()
            .take(self.required_accounts_len as usize)
            .map(|bytes| Pubkey::new_from_array(*bytes))
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
pub struct HookPostShield {
    pub origin_mint: Pubkey,
    pub commitment: [u8; 32],
}

#[event]
pub struct Transferred {
    pub origin_mint: Pubkey,
    pub nullifiers: Vec<[u8; 32]>,
    pub new_root: [u8; 32],
}

#[event]
pub struct HookConfigUpdated {
    pub origin_mint: Pubkey,
    pub post_shield_program: Pubkey,
    pub post_unshield_program: Pubkey,
    pub mode: u8,
}

#[event]
pub struct InvariantOk {
    pub origin_mint: Pubkey,
    pub vault: Pubkey,
    pub supply_ptkn: u64,
    pub live_notes: u64,
    pub protocol_fees: u64,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum HookAccountMode {
    Strict = 0,
    Lenient = 1,
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
    #[msg("vault token account mismatch")]
    VaultTokenAccountMismatch,
    #[msg("invalid depositor token account")]
    InvalidDepositorAccount,
    #[msg("twin mint mismatch")]
    TwinMintMismatch,
    #[msg("twin mint account required")]
    TwinMintNotConfigured,
    #[msg("twin mint authority mismatch")]
    TwinMintAuthorityMismatch,
    #[msg("twin mint decimals mismatch")]
    TwinMintDecimalsMismatch,
    #[msg("supply invariant breached")]
    InvariantBreach,
    #[msg("hooks feature disabled")]
    HooksDisabled,
    #[msg("too many hook accounts configured")]
    TooManyHookAccounts,
}
