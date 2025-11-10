use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount};
use ark_bn254::Fr;
use ark_ff::{BigInteger, BigInteger256, Field, PrimeField};
use core::convert::TryFrom;
use sha3::{Digest, Keccak256};

use ptf_common::hooks::{HookInstruction, PostShieldHook, PostUnshieldHook};
use ptf_common::{
    seeds, FeatureFlags, FEATURE_HOOKS_ENABLED, FEATURE_PRIVATE_TRANSFER_ENABLED, MAX_BPS,
};
use ptf_factory::MintMapping;
use ptf_vault::program::PtfVault;
use ptf_vault::{self};
use ptf_verifier_groth16::program::PtfVerifierGroth16;
use ptf_verifier_groth16::{self, VerifyingKeyAccount};

declare_id!("4Tx3v6is7qeVjdHvL3a16ggB9VVMBPVhpPSkUGoXZhre");

const DEFAULT_CANOPY_DEPTH: u8 = 8;

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
        pool_state.verifying_key_hash = ctx.accounts.verifying_key.hash;
        pool_state.authority = ctx.accounts.authority.key();
        pool_state.fee_bps = fee_bps;
        pool_state.features = FeatureFlags::from(features);
        pool_state.bump = ctx.bumps.pool_state;
        pool_state.commitment_tree = ctx.accounts.commitment_tree.key();
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
        nulls.bloom = [0u8; NullifierSet::BLOOM_BYTES];

        let tree = &mut ctx.accounts.commitment_tree;
        tree.init(
            pool_state.key(),
            DEFAULT_CANOPY_DEPTH,
            ctx.bumps.commitment_tree,
        )?;
        pool_state.current_root = tree.current_root;
        pool_state.roots_len = 1;
        pool_state.recent_roots[0] = tree.current_root;

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

    pub fn shield<'info>(
        ctx: Context<'_, '_, '_, 'info, Shield<'info>>,
        args: ShieldArgs,
    ) -> Result<()> {
        let (origin_mint, hook_enabled, pool_key, pool_bump) = {
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
            require!(
                ctx.accounts.verifying_key.hash == pool_state.verifying_key_hash,
                PoolError::VerifyingKeyHashMismatch,
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
            require_keys_eq!(
                ctx.accounts.commitment_tree.key(),
                pool_state.commitment_tree,
                PoolError::CommitmentTreeMismatch,
            );
            require!(
                ctx.accounts.commitment_tree.current_root == pool_state.current_root,
                PoolError::RootMismatch,
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

            let new_root = ctx
                .accounts
                .commitment_tree
                .append_note(args.commitment, args.amount_commit)?;
            require!(new_root == args.new_root, PoolError::RootMismatch);
            pool_state.push_root(new_root);

            pool_state.total_shielded = pool_state
                .total_shielded
                .checked_add(args.amount)
                .ok_or(PoolError::AmountOverflow)?;

            let origin_mint = pool_state.origin_mint;
            emit!(Shielded {
                origin_mint,
                depositor: ctx.accounts.payer.key(),
                commitment: args.commitment,
                root: new_root,
                amount_commit: args.amount_commit,
            });

            let hook_enabled = pool_state
                .features
                .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED))
                && pool_state.hook_config_present;
            let pool_key = pool_state.key();
            let pool_bump = pool_state.bump;

            (origin_mint, hook_enabled, pool_key, pool_bump)
        };

        if hook_enabled {
            let hook_config_account = &ctx.accounts.hook_config;
            let required_accounts: Vec<Pubkey> = hook_config_account.required_keys().collect();
            let hook_mode = hook_config_account.mode;
            let target_program = hook_config_account.post_shield_program_id;
            if target_program != Pubkey::default() {
                validate_hook_accounts(&required_accounts, hook_mode, ctx.remaining_accounts)?;

                let mut metas = Vec::with_capacity(2 + ctx.remaining_accounts.len());
                let mut infos = Vec::with_capacity(2 + ctx.remaining_accounts.len());

                let hook_config_info = ctx.accounts.hook_config.to_account_info();
                let pool_info = ctx.accounts.pool_state.to_account_info();
                metas.push(AccountMeta::new_readonly(hook_config_info.key(), false));
                metas.push(AccountMeta::new_readonly(pool_info.key(), false));
                infos.push(hook_config_info);
                infos.push(pool_info);

                for account in ctx.remaining_accounts.iter() {
                    let meta = if account.is_writable {
                        AccountMeta::new(account.key(), account.is_signer)
                    } else {
                        AccountMeta::new_readonly(account.key(), account.is_signer)
                    };
                    metas.push(meta);
                    infos.push(account.clone());
                }

                let ix = Instruction {
                    program_id: target_program,
                    accounts: metas,
                    data: HookInstruction::PostShield(PostShieldHook {
                        origin_mint,
                        pool: pool_key,
                        depositor: ctx.accounts.payer.key(),
                        commitment: args.commitment,
                        amount_commit: args.amount_commit,
                        amount: args.amount,
                    })
                    .try_to_vec()?,
                };

                let signer_seeds: [&[u8]; 3] = [seeds::POOL, origin_mint.as_ref(), &[pool_bump]];
                invoke_signed(&ix, &infos, &[&signer_seeds])?;

                emit!(HookPostShield {
                    origin_mint,
                    commitment: args.commitment,
                });
            }
        }

        enforce_supply_invariant(
            &ctx.accounts.pool_state,
            &ctx.accounts.vault_token_account,
            ctx.accounts.twin_mint.as_ref(),
        )?;
        Ok(())
    }

    pub fn unshield_to_origin<'info>(
        ctx: Context<'_, '_, '_, 'info, Unshield<'info>>,
        args: UnshieldArgs,
    ) -> Result<()> {
        process_unshield(ctx, args, UnshieldMode::Origin)
    }

    pub fn unshield_to_ptkn<'info>(
        ctx: Context<'_, '_, '_, 'info, Unshield<'info>>,
        args: UnshieldArgs,
    ) -> Result<()> {
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
        emit!(NullifierUsed {
            origin_mint: ctx.accounts.pool_state.origin_mint,
            nullifier,
        });
        Ok(())
    }

    pub fn private_transfer(ctx: Context<PrivateTransfer>, args: TransferArgs) -> Result<()> {
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
        require!(
            ctx.accounts.verifying_key.hash == pool_state.verifying_key_hash,
            PoolError::VerifyingKeyHashMismatch,
        );
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
        require!(
            ctx.accounts.commitment_tree.current_root == args.old_root,
            PoolError::RootMismatch,
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

        let origin_mint = pool_state.origin_mint;
        for nullifier in &args.nullifiers {
            ctx.accounts
                .nullifier_set
                .insert(*nullifier)
                .map_err(|_| PoolError::NullifierReuse)?;
            emit!(NullifierUsed {
                origin_mint,
                nullifier: *nullifier,
            });
        }
        require!(
            args.output_commitments.len() == args.output_amount_commitments.len(),
            PoolError::OutputSetMismatch,
        );
        let new_root = ctx.accounts.commitment_tree.append_many(
            args.output_commitments.as_slice(),
            args.output_amount_commitments.as_slice(),
        )?;
        require!(new_root == args.new_root, PoolError::RootMismatch);
        pool_state.push_root(new_root);

        emit!(Transferred {
            origin_mint: pool_state.origin_mint,
            nullifiers: args.nullifiers.clone(),
            new_root,
            outputs: args.output_commitments.clone(),
        });
        Ok(())
    }
}

fn process_unshield<'info>(
    ctx: Context<'_, '_, '_, 'info, Unshield<'info>>,
    args: UnshieldArgs,
    mode: UnshieldMode,
) -> Result<()> {
    let (origin_mint, destination_owner, fee, hook_enabled, pool_key, pool_bump) = {
        let pool_state = &mut ctx.accounts.pool_state;
        let origin_mint = pool_state.origin_mint;
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
        require!(
            ctx.accounts.verifying_key.hash == pool_state.verifying_key_hash,
            PoolError::VerifyingKeyHashMismatch,
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
            origin_mint,
            PoolError::OriginMintMismatch,
        );
        require_keys_eq!(
            ctx.accounts.vault_token_account.owner,
            pool_state.vault,
            PoolError::VaultTokenAccountMismatch,
        );
        require_keys_eq!(
            ctx.accounts.vault_token_account.mint,
            origin_mint,
            PoolError::OriginMintMismatch,
        );
        require_keys_eq!(
            ctx.accounts.commitment_tree.key(),
            pool_state.commitment_tree,
            PoolError::CommitmentTreeMismatch,
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
        require!(
            ctx.accounts.commitment_tree.current_root == args.old_root,
            PoolError::RootMismatch,
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
            emit!(NullifierUsed {
                origin_mint,
                nullifier: *nullifier,
            });
        }

        pool_state.total_shielded = pool_state
            .total_shielded
            .checked_sub(total_spent)
            .ok_or(PoolError::AmountOverflow)?;
        pool_state.protocol_fees = pool_state
            .protocol_fees
            .checked_add(fee)
            .ok_or(PoolError::AmountOverflow)?;
        require!(
            args.output_commitments.len() == args.output_amount_commitments.len(),
            PoolError::OutputSetMismatch,
        );
        let new_root = ctx.accounts.commitment_tree.append_many(
            args.output_commitments.as_slice(),
            args.output_amount_commitments.as_slice(),
        )?;
        require!(new_root == args.new_root, PoolError::RootMismatch);
        pool_state.push_root(new_root);

        let destination_owner = ctx.accounts.destination_token_account.owner;
        match mode {
            UnshieldMode::Origin => {
                require_keys_eq!(
                    ctx.accounts.destination_token_account.mint,
                    origin_mint,
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
                    destination_token_account: ctx
                        .accounts
                        .destination_token_account
                        .to_account_info(),
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
                    origin_mint,
                    destination: destination_owner,
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
                    origin_mint,
                    destination: destination_owner,
                    amount: args.amount,
                    fee,
                });
            }
        }

        let hook_enabled = pool_state
            .features
            .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED))
            && pool_state.hook_config_present;
        let pool_key = pool_state.key();
        let pool_bump = pool_state.bump;

        (
            origin_mint,
            destination_owner,
            fee,
            hook_enabled,
            pool_key,
            pool_bump,
        )
    };

    if hook_enabled {
        let hook_config_account = &ctx.accounts.hook_config;
        let required_accounts: Vec<Pubkey> = hook_config_account.required_keys().collect();
        let hook_mode = hook_config_account.mode;
        let target_program = hook_config_account.post_unshield_program_id;
        if target_program != Pubkey::default() {
            validate_hook_accounts(&required_accounts, hook_mode, ctx.remaining_accounts)?;

            let mut metas = Vec::with_capacity(2 + ctx.remaining_accounts.len());
            let mut infos = Vec::with_capacity(2 + ctx.remaining_accounts.len());

            let hook_config_info = ctx.accounts.hook_config.to_account_info();
            let pool_info = ctx.accounts.pool_state.to_account_info();
            metas.push(AccountMeta::new_readonly(hook_config_info.key(), false));
            metas.push(AccountMeta::new_readonly(pool_info.key(), false));
            infos.push(hook_config_info);
            infos.push(pool_info);

            for account in ctx.remaining_accounts.iter() {
                let meta = if account.is_writable {
                    AccountMeta::new(account.key(), account.is_signer)
                } else {
                    AccountMeta::new_readonly(account.key(), account.is_signer)
                };
                metas.push(meta);
                infos.push(account.clone());
            }

            let ix = Instruction {
                program_id: target_program,
                accounts: metas,
                data: HookInstruction::PostUnshield(PostUnshieldHook {
                    origin_mint,
                    pool: pool_key,
                    destination: destination_owner,
                    mode: mode as u8,
                    amount: args.amount,
                    fee,
                })
                .try_to_vec()?,
            };

            let signer_seeds: [&[u8]; 3] = [seeds::POOL, origin_mint.as_ref(), &[pool_bump]];
            invoke_signed(&ix, &infos, &[&signer_seeds])?;

            emit!(HookPostUnshield {
                origin_mint,
                mode: mode as u8,
                destination: destination_owner,
                amount: args.amount,
            });
        }
    }

    enforce_supply_invariant(
        &ctx.accounts.pool_state,
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

fn poseidon_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut state = [
        Fr::from(0u64),
        Fr::from_le_bytes_mod_order(left),
        Fr::from_le_bytes_mod_order(right),
    ];
    const ROUNDS: usize = 8;
    for round in 0..ROUNDS {
        let c0 = Fr::from(17u64 + round as u64);
        let c1 = Fr::from(45u64 + round as u64);
        let c2 = Fr::from(73u64 + round as u64);
        state[0] += c0;
        state[1] += c1;
        state[2] += c2;
        for value in state.iter_mut() {
            *value = value.pow([5u64]);
        }
        let mix0 = state[0] + state[1] + state[2];
        let mix1 = state[0] + state[1].double();
        let mix2 = state[0] + state[2].double();
        state = [mix0, mix1, mix2];
    }
    fr_to_bytes(&state[0])
}

fn fr_to_bytes(value: &Fr) -> [u8; 32] {
    let bigint: BigInteger256 = value.into_bigint();
    let bytes = bigint.to_bytes_le();
    let mut array = [0u8; 32];
    array.copy_from_slice(&bytes);
    array
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
        seeds = [seeds::TREE, origin_mint.key().as_ref()],
        bump,
        space = CommitmentTree::SPACE,
    )]
    pub commitment_tree: Account<'info, CommitmentTree>,
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
    #[account(
        seeds = [seeds::HOOKS, pool_state.origin_mint.as_ref()],
        bump = pool_state.hook_config_bump,
        constraint = hook_config.pool == pool_state.key() @ PoolError::HookConfigInvalid,
    )]
    pub hook_config: Account<'info, HookConfig>,
    #[account(mut, seeds = [seeds::NULLIFIERS, pool_state.origin_mint.as_ref()], bump = nullifier_set.bump)]
    pub nullifier_set: Account<'info, NullifierSet>,
    #[account(mut, seeds = [seeds::TREE, pool_state.origin_mint.as_ref()], bump = commitment_tree.bump, constraint = commitment_tree.pool == pool_state.key() @ PoolError::CommitmentTreeMismatch)]
    pub commitment_tree: Account<'info, CommitmentTree>,
    #[account(mut, seeds = [seeds::VAULT, pool_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub twin_mint: Option<Account<'info, Mint>>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(
        address = pool_state.verifying_key,
        constraint = verifying_key.hash == pool_state.verifying_key_hash @ PoolError::VerifyingKeyHashMismatch,
    )]
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
    #[account(
        seeds = [seeds::HOOKS, pool_state.origin_mint.as_ref()],
        bump = pool_state.hook_config_bump,
        constraint = hook_config.pool == pool_state.key() @ PoolError::HookConfigInvalid,
    )]
    pub hook_config: Account<'info, HookConfig>,
    #[account(mut, seeds = [seeds::NULLIFIERS, pool_state.origin_mint.as_ref()], bump = nullifier_set.bump)]
    pub nullifier_set: Account<'info, NullifierSet>,
    #[account(mut, seeds = [seeds::TREE, pool_state.origin_mint.as_ref()], bump = commitment_tree.bump, constraint = commitment_tree.pool == pool_state.key() @ PoolError::CommitmentTreeMismatch)]
    pub commitment_tree: Account<'info, CommitmentTree>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(
        address = pool_state.verifying_key,
        constraint = verifying_key.hash == pool_state.verifying_key_hash @ PoolError::VerifyingKeyHashMismatch,
    )]
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
        constraint = hook_config.pool == pool_state.key() @ PoolError::HookConfigInvalid,
    )]
    pub hook_config: Account<'info, HookConfig>,
}

#[derive(Accounts)]
pub struct PrivateTransfer<'info> {
    #[account(mut, seeds = [seeds::POOL, pool_state.origin_mint.as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,
    #[account(mut, seeds = [seeds::NULLIFIERS, pool_state.origin_mint.as_ref()], bump = nullifier_set.bump)]
    pub nullifier_set: Account<'info, NullifierSet>,
    #[account(mut, seeds = [seeds::TREE, pool_state.origin_mint.as_ref()], bump = commitment_tree.bump, constraint = commitment_tree.pool == pool_state.key() @ PoolError::CommitmentTreeMismatch)]
    pub commitment_tree: Account<'info, CommitmentTree>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(
        address = pool_state.verifying_key,
        constraint = verifying_key.hash == pool_state.verifying_key_hash @ PoolError::VerifyingKeyHashMismatch,
    )]
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
    pub output_commitments: Vec<[u8; 32]>,
    pub output_amount_commitments: Vec<[u8; 32]>,
    pub amount: u64,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransferArgs {
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub nullifiers: Vec<[u8; 32]>,
    pub output_commitments: Vec<[u8; 32]>,
    pub output_amount_commitments: Vec<[u8; 32]>,
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
pub struct CommitmentTree {
    pub pool: Pubkey,
    pub canopy_depth: u8,
    pub next_index: u64,
    pub current_root: [u8; 32],
    pub frontier: [[u8; 32]; Self::DEPTH],
    pub zeroes: [[u8; 32]; Self::DEPTH],
    pub canopy: [[u8; 32]; Self::MAX_CANOPY],
    pub recent_commitments: [[u8; 32]; Self::MAX_CANOPY],
    pub recent_amount_commitments: [[u8; 32]; Self::MAX_CANOPY],
    pub recent_len: u8,
    pub bump: u8,
}

impl CommitmentTree {
    pub const DEPTH: usize = ptf_common::MERKLE_DEPTH as usize;
    pub const MAX_CANOPY: usize = 16;
    pub const SPACE: usize = 8
        + 32
        + 1
        + 8
        + 32
        + (Self::DEPTH * 32)
        + (Self::DEPTH * 32)
        + (Self::MAX_CANOPY * 32)
        + (Self::MAX_CANOPY * 32)
        + (Self::MAX_CANOPY * 32)
        + 1
        + 1
        + 6;

    pub fn init(&mut self, pool: Pubkey, canopy_depth: u8, bump: u8) -> Result<()> {
        require!(
            (canopy_depth as usize) <= Self::MAX_CANOPY,
            PoolError::CanopyDepthInvalid,
        );
        self.pool = pool;
        self.canopy_depth = canopy_depth;
        self.bump = bump;
        self.next_index = 0;
        self.zeroes = Self::compute_zeroes();
        self.frontier = [[0u8; 32]; Self::DEPTH];
        self.current_root = self.zeroes[Self::DEPTH - 1];
        self.canopy = [[0u8; 32]; Self::MAX_CANOPY];
        self.recent_commitments = [[0u8; 32]; Self::MAX_CANOPY];
        self.recent_amount_commitments = [[0u8; 32]; Self::MAX_CANOPY];
        self.recent_len = 0;
        Ok(())
    }

    pub fn append_note(
        &mut self,
        commitment: [u8; 32],
        amount_commit: [u8; 32],
    ) -> Result<[u8; 32]> {
        self.insert_leaf(commitment, amount_commit)
    }

    pub fn append_many(
        &mut self,
        commitments: &[[u8; 32]],
        amount_commitments: &[[u8; 32]],
    ) -> Result<[u8; 32]> {
        if commitments.is_empty() {
            return Ok(self.current_root);
        }
        require!(
            commitments.len() == amount_commitments.len(),
            PoolError::OutputSetMismatch,
        );
        let mut root = self.current_root;
        for (commitment, amount_commit) in commitments.iter().zip(amount_commitments.iter()) {
            root = self.insert_leaf(*commitment, *amount_commit)?;
        }
        Ok(root)
    }

    fn insert_leaf(&mut self, commitment: [u8; 32], amount_commit: [u8; 32]) -> Result<[u8; 32]> {
        require!(
            self.next_index < (1u128 << Self::DEPTH) as u64,
            PoolError::TreeFull,
        );
        let mut node = commitment;
        let mut index = self.next_index;
        let mut path_hashes = [[0u8; 32]; Self::DEPTH];
        for level in 0..Self::DEPTH {
            if index % 2 == 0 {
                self.frontier[level] = node;
                let left = node;
                let right = self.zeroes[level];
                node = poseidon_hash(&left, &right);
            } else {
                let left = self.frontier[level];
                node = poseidon_hash(&left, &node);
            }
            path_hashes[level] = node;
            index >>= 1;
        }
        self.next_index = self
            .next_index
            .checked_add(1)
            .ok_or(PoolError::AmountOverflow)?;
        self.current_root = node;
        self.update_canopy(&path_hashes);
        self.record_recent(commitment, amount_commit);
        Ok(self.current_root)
    }

    fn update_canopy(&mut self, path_hashes: &[[u8; 32]; Self::DEPTH]) {
        if self.canopy_depth == 0 {
            return;
        }
        let canopy_len = core::cmp::min(self.canopy_depth as usize, Self::MAX_CANOPY);
        for offset in 0..canopy_len {
            let level = Self::DEPTH - 1 - offset;
            self.canopy[offset] = path_hashes[level];
        }
    }

    fn record_recent(&mut self, commitment: [u8; 32], amount_commit: [u8; 32]) {
        if (self.recent_len as usize) < Self::MAX_CANOPY {
            let idx = self.recent_len as usize;
            self.recent_commitments[idx] = commitment;
            self.recent_amount_commitments[idx] = amount_commit;
            self.recent_len += 1;
        } else {
            for idx in 1..Self::MAX_CANOPY {
                self.recent_commitments[idx - 1] = self.recent_commitments[idx];
                self.recent_amount_commitments[idx - 1] = self.recent_amount_commitments[idx];
            }
            self.recent_commitments[Self::MAX_CANOPY - 1] = commitment;
            self.recent_amount_commitments[Self::MAX_CANOPY - 1] = amount_commit;
        }
    }

    fn compute_zeroes() -> [[u8; 32]; Self::DEPTH] {
        let mut zeroes = [[0u8; 32]; Self::DEPTH];
        let mut current = poseidon_hash(&[0u8; 32], &[0u8; 32]);
        zeroes[0] = current;
        for level in 1..Self::DEPTH {
            current = poseidon_hash(&zeroes[level - 1], &zeroes[level - 1]);
            zeroes[level] = current;
        }
        zeroes
    }
}

#[account]
pub struct PoolState {
    pub authority: Pubkey,
    pub origin_mint: Pubkey,
    pub vault: Pubkey,
    pub verifier_program: Pubkey,
    pub verifying_key: Pubkey,
    pub commitment_tree: Pubkey,
    pub verifying_key_id: [u8; 32],
    pub verifying_key_hash: [u8; 32],
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
    pub const SPACE: usize = 8
        + 32 // authority
        + 32 // origin mint
        + 32 // vault
        + 32 // verifier program
        + 32 // verifying key
        + 32 // commitment tree
        + 32 // verifying key id
        + 32 // verifying key hash
        + 32 // current root
        + (Self::MAX_ROOTS * 32)
        + 1 // roots len
        + 2 // fee bps
        + 1 // features
        + 8 // total shielded
        + 8 // protocol fees
        + 32 // hook config
        + 1 // hook config present
        + 1 // hook config bump
        + 1 // bump
        + 32 // twin mint
        + 1 // twin mint enabled
        + 5; // padding

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
    pub bloom: [u8; Self::BLOOM_BYTES],
    pub bump: u8,
}

impl NullifierSet {
    pub const MAX_NULLIFIERS: usize = 256;
    pub const BLOOM_BYTES: usize = 512;
    pub const SPACE: usize = 8 + 32 + 4 + (Self::MAX_NULLIFIERS * 32) + Self::BLOOM_BYTES + 1 + 3;

    pub fn insert(&mut self, value: [u8; 32]) -> Result<()> {
        if self.contains(&value) {
            return err!(PoolError::NullifierReuse);
        }
        require!(
            (self.count as usize) < Self::MAX_NULLIFIERS,
            PoolError::NullifierCapacity,
        );
        self.entries[self.count as usize] = value;
        self.count += 1;
        self.set_bloom_bits(&value);
        Ok(())
    }

    fn contains(&self, value: &[u8; 32]) -> bool {
        if !self.test_bloom_bits(value) {
            return false;
        }
        for idx in 0..self.count as usize {
            if self.entries[idx] == *value {
                return true;
            }
        }
        false
    }

    fn set_bloom_bits(&mut self, value: &[u8; 32]) {
        for position in Self::bloom_positions(value) {
            let byte_index = position / 8;
            let bit_index = position % 8;
            self.bloom[byte_index] |= 1 << bit_index;
        }
    }

    fn test_bloom_bits(&self, value: &[u8; 32]) -> bool {
        for position in Self::bloom_positions(value) {
            let byte_index = position / 8;
            let bit_index = position % 8;
            if (self.bloom[byte_index] & (1 << bit_index)) == 0 {
                return false;
            }
        }
        true
    }

    fn bloom_positions(value: &[u8; 32]) -> [usize; 3] {
        let mut hasher = Keccak256::new();
        hasher.update(value);
        let bytes: [u8; 32] = hasher.finalize().into();
        let mut positions = [0usize; 3];
        for (idx, chunk) in positions.iter_mut().enumerate() {
            let start = idx * 8;
            let mut slice = [0u8; 8];
            slice.copy_from_slice(&bytes[start..start + 8]);
            let value = u64::from_le_bytes(slice) as usize;
            *chunk = value % (Self::BLOOM_BYTES * 8);
        }
        positions
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
    pub outputs: Vec<[u8; 32]>,
    pub new_root: [u8; 32],
}

#[event]
pub struct NullifierUsed {
    pub origin_mint: Pubkey,
    pub nullifier: [u8; 32],
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
    #[msg("verifying key hash mismatch")]
    VerifyingKeyHashMismatch,
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
    #[msg("hook configuration invalid")]
    HookConfigInvalid,
    #[msg("hook account set is invalid")]
    HookAccountMismatch,
    #[msg("required hook account missing")]
    HookAccountMissing,
    #[msg("unexpected hook account provided")]
    HookAccountUnexpected,
    #[msg("commitment tree account mismatch")]
    CommitmentTreeMismatch,
    #[msg("output set mismatch")]
    OutputSetMismatch,
    #[msg("merkle tree canopy depth invalid")]
    CanopyDepthInvalid,
    #[msg("merkle tree capacity reached")]
    TreeFull,
    #[msg("supplied root does not match computed root")]
    RootMismatch,
}

fn validate_hook_accounts(
    required_accounts: &[Pubkey],
    mode: HookAccountMode,
    remaining_accounts: &[AccountInfo<'_>],
) -> Result<()> {
    match mode {
        HookAccountMode::Strict => {
            require!(
                remaining_accounts.len() == required_accounts.len(),
                PoolError::HookAccountMismatch
            );
            for (expected, provided) in required_accounts.iter().zip(remaining_accounts.iter()) {
                require_keys_eq!(*expected, provided.key(), PoolError::HookAccountMismatch);
            }
        }
        HookAccountMode::Lenient => {
            for expected in required_accounts {
                require!(
                    remaining_accounts
                        .iter()
                        .any(|account| account.key() == *expected),
                    PoolError::HookAccountMissing
                );
            }
        }
    }

    if matches!(mode, HookAccountMode::Strict) {
        for account in remaining_accounts.iter() {
            require!(
                required_accounts.iter().any(|key| *key == account.key()),
                PoolError::HookAccountUnexpected
            );
        }
    }

    Ok(())
}
