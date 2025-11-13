use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use ark_bn254::Fr;
use ark_ff::{BigInteger, BigInteger256, PrimeField};
#[cfg(feature = "invariant_checks")]
use core::convert::TryFrom;
use sha3::{Digest, Keccak256};

use ptf_common::hooks::{HookInstruction, PostShieldHook, PostUnshieldHook};
use ptf_common::{
    seeds, FeatureFlags, FEATURE_HOOKS_ENABLED, FEATURE_PRIVATE_TRANSFER_ENABLED, MAX_BPS,
};
use ptf_factory::{program::PtfFactory, MintMapping};
use ptf_vault::program::PtfVault;
use ptf_vault::{self};
use ptf_verifier_groth16::program::PtfVerifierGroth16;
use ptf_verifier_groth16::{self, VerifyingKeyAccount};

mod poseidon;

declare_id!("7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh");

const DEFAULT_CANOPY_DEPTH: u8 = 8;

#[program]
pub mod ptf_pool {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16, features: u8) -> Result<()> {
        require!(fee_bps <= MAX_BPS, PoolError::InvalidFeeBps);

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

        let pool_key = ctx.accounts.pool_state.key();
        let mut pool_state = ctx.accounts.pool_state.load_init()?;
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
        pool_state.note_ledger = ctx.accounts.note_ledger.key();
        pool_state.note_ledger_bump = ctx.bumps.note_ledger;
        pool_state.protocol_fees = 0;
        pool_state.hook_config = ctx.accounts.hook_config.key();
        pool_state.hook_config_present = false;
        pool_state.hook_config_bump = ctx.bumps.hook_config;
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
                        ctx.accounts.factory_state.key(),
                        PoolError::TwinMintAuthorityMismatch,
                    );
                }
                COption::None => return err!(PoolError::TwinMintAuthorityMismatch),
            }
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
            pool_key,
            PoolError::MismatchedVaultAuthority,
        );

        {
            let mut hook_config = ctx.accounts.hook_config.load_init()?;
            hook_config.pool = pool_key;
            hook_config.post_shield_program_id = Pubkey::default();
            hook_config.post_unshield_program_id = Pubkey::default();
            hook_config.required_accounts = [[0u8; 32]; HookConfig::MAX_REQUIRED_ACCOUNTS];
            hook_config.required_accounts_len = 0;
            hook_config.mode = HookAccountMode::Strict;
            hook_config.bump = ctx.bumps.hook_config;
        }

        {
            let mut nulls = ctx.accounts.nullifier_set.load_init()?;
            nulls.pool = pool_key;
            nulls.bump = ctx.bumps.nullifier_set;
            nulls.count = 0;
            nulls.bloom = [0u8; NullifierSet::BLOOM_BYTES];
        }

        {
            let mut tree = ctx.accounts.commitment_tree.load_init()?;
            tree.init(pool_key, DEFAULT_CANOPY_DEPTH, ctx.bumps.commitment_tree)?;
            pool_state.current_root = tree.current_root;
            pool_state.roots_len = 1;
            pool_state.recent_roots[0] = tree.current_root;
        }

        {
            let mut ledger = ctx.accounts.note_ledger.load_init()?;
            ledger.init(pool_key, ctx.bumps.note_ledger);
        }

        emit!(PoolInitialized {
            origin_mint: pool_state.origin_mint,
            fee_bps,
            features,
        });
        Ok(())
    }

    pub fn set_fee(ctx: Context<UpdateAuthority>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_BPS, PoolError::InvalidFeeBps);
        let mut pool_state = ctx.accounts.pool_state.load_mut()?;
        pool_state.fee_bps = fee_bps;
        emit!(FeeUpdated {
            origin_mint: pool_state.origin_mint,
            fee_bps,
        });
        Ok(())
    }

    pub fn set_features(ctx: Context<UpdateAuthority>, features: u8) -> Result<()> {
        let mut pool_state = ctx.accounts.pool_state.load_mut()?;
        pool_state.features = FeatureFlags::from(features);
        emit!(FeaturesUpdated {
            origin_mint: pool_state.origin_mint,
            features,
        });
        Ok(())
    }

    pub fn configure_hooks(ctx: Context<ConfigureHooks>, args: HookConfigArgs) -> Result<()> {
        let mut pool_state = ctx.accounts.pool_state.load_mut()?;
        require!(
            pool_state
                .features
                .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED)),
            PoolError::HooksDisabled,
        );

        let mut hook_config = ctx.accounts.hook_config.load_mut()?;
        hook_config.pool = ctx.accounts.pool_state.key();
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

        pool_state.hook_config = ctx.accounts.hook_config.key();
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
        let (origin_mint, hook_enabled, pool_key, pool_bump, commitment_bytes) = {
            let pool_loader = &ctx.accounts.pool_state;
            let mut pool_state = pool_loader.load_mut()?;
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
                pool_loader.key(),
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
            {
                let commitment_tree_data = ctx.accounts.commitment_tree.load()?;
                require!(
                    commitment_tree_data.current_root == pool_state.current_root,
                    PoolError::RootMismatch,
                );
            }

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

            let public_fields = parse_field_elements(&args.public_inputs)?;
            require!(public_fields.len() >= 3, PoolError::InvalidPublicInputs);

            let old_root_bytes = public_fields[0];
            let new_root_bytes = public_fields[1];
            let commitment_bytes = public_fields[2];
            let mut old_root_be = old_root_bytes;
            old_root_be.reverse();
            let mut new_root_be = new_root_bytes;
            new_root_be.reverse();

            require!(
                old_root_bytes == pool_state.current_root,
                PoolError::RootMismatch
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

            #[cfg(feature = "full_tree")]
            let (new_root, _note_index) = {
                let mut commitment_tree = ctx.accounts.commitment_tree.load_mut()?;
                commitment_tree.append_note(commitment_bytes, args.amount_commit)?
            };
            #[cfg(not(feature = "full_tree"))]
            let (new_root, _note_index) = {
                let mut commitment_tree = ctx.accounts.commitment_tree.load_mut()?;
                require!(
                    commitment_tree.next_index < (1u128 << CommitmentTree::DEPTH) as u64,
                    PoolError::TreeFull
                );
                let note_index = commitment_tree.next_index;
                commitment_tree.next_index = commitment_tree
                    .next_index
                    .checked_add(1)
                    .ok_or(PoolError::AmountOverflow)?;
                commitment_tree.current_root = new_root_bytes;
                (new_root_bytes, note_index)
            };
            require!(new_root_bytes == new_root, PoolError::RootMismatch);
            pool_state.push_root(new_root);
            {
                let mut note_ledger = ctx.accounts.note_ledger.load_mut()?;
                note_ledger.record_shield(args.amount, args.amount_commit)?;
            }

            let hook_enabled = pool_state
                .features
                .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED))
                && pool_state.hook_config_present;
            let pool_key = pool_loader.key();
            let pool_bump = pool_state.bump;

            let origin_mint = pool_state.origin_mint;
            (
                origin_mint,
                hook_enabled,
                pool_key,
                pool_bump,
                commitment_bytes,
            )
        };
        if hook_enabled {
            let (required_accounts, hook_mode, target_program) = {
                let hook_config = ctx.accounts.hook_config.load()?;
                (
                    hook_config.required_keys().collect::<Vec<_>>(),
                    hook_config.mode,
                    hook_config.post_shield_program_id,
                )
            };
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
                        commitment: commitment_bytes,
                        amount_commit: args.amount_commit,
                        amount: args.amount,
                    })
                    .try_to_vec()?,
                };

                let signer_seeds: [&[u8]; 3] = [seeds::POOL, origin_mint.as_ref(), &[pool_bump]];
                invoke_signed(&ix, &infos, &[&signer_seeds])?;
            }
        }

        #[cfg(feature = "invariant_checks")]
        {
            let pool_state = ctx.accounts.pool_state.load()?;
            let note_ledger = ctx.accounts.note_ledger.load()?;
            enforce_supply_invariant(
                &pool_state,
                &note_ledger,
                &ctx.accounts.vault_token_account,
                ctx.accounts.twin_mint.as_ref(),
            )?;
        }
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
        process_unshield(ctx, args, UnshieldMode::Twin)
    }

    pub fn accept_root(ctx: Context<UpdateAuthority>, root: [u8; 32]) -> Result<()> {
        let mut pool_state = ctx.accounts.pool_state.load_mut()?;
        pool_state.push_root(root);
        Ok(())
    }

    pub fn write_nullifier(ctx: Context<UpdateAuthority>, nullifier: [u8; 32]) -> Result<()> {
        {
            let mut nullifier_set = ctx.accounts.nullifier_set.load_mut()?;
            nullifier_set
                .insert(nullifier)
                .map_err(|_| PoolError::NullifierReuse)?;
        }
        let pool_state = ctx.accounts.pool_state.load()?;
        emit!(PTFNullifierUsed {
            mint: pool_state.origin_mint,
            nullifier,
        });
        Ok(())
    }

    pub fn private_transfer(ctx: Context<PrivateTransfer>, args: TransferArgs) -> Result<()> {
        let pool_loader = &ctx.accounts.pool_state;
        let mut pool_state = pool_loader.load_mut()?;
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
        {
            let commitment_tree = ctx.accounts.commitment_tree.load()?;
            require!(
                commitment_tree.current_root == args.old_root,
                PoolError::RootMismatch,
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

        let origin_mint = pool_state.origin_mint;
        {
            let mut nullifier_set = ctx.accounts.nullifier_set.load_mut()?;
            for nullifier in &args.nullifiers {
                nullifier_set
                    .insert(*nullifier)
                    .map_err(|_| PoolError::NullifierReuse)?;
                emit!(PTFNullifierUsed {
                    mint: origin_mint,
                    nullifier: *nullifier,
                });
            }
        }
        require!(
            args.output_commitments.len() == args.output_amount_commitments.len(),
            PoolError::OutputSetMismatch,
        );
        let (new_root, _output_indices) = {
            let mut commitment_tree = ctx.accounts.commitment_tree.load_mut()?;
            commitment_tree.append_many(
                args.output_commitments.as_slice(),
                args.output_amount_commitments.as_slice(),
            )?
        };
        require!(new_root == args.new_root, PoolError::RootMismatch);
        pool_state.push_root(new_root);

        {
            let mut note_ledger = ctx.accounts.note_ledger.load_mut()?;
            note_ledger
                .record_transfer(&args.nullifiers, args.output_amount_commitments.as_slice())?;
        }

        emit!(PTFTransferred {
            mint: pool_state.origin_mint,
            inputs: args.nullifiers.clone(),
            outputs: args.output_commitments.clone(),
            root: new_root,
        });
        Ok(())
    }
}

fn process_unshield<'info>(
    ctx: Context<'_, '_, '_, 'info, Unshield<'info>>,
    args: UnshieldArgs,
    mode: UnshieldMode,
) -> Result<()> {
    let pool_loader = &ctx.accounts.pool_state;
    let mut pool_state = pool_loader.load_mut()?;
    let mut note_ledger = ctx.accounts.note_ledger.load_mut()?;
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
        pool_loader.key(),
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
    {
        let commitment_tree = ctx.accounts.commitment_tree.load()?;
        require!(
            commitment_tree.current_root == args.old_root,
            PoolError::RootMismatch,
        );
    }
    require!(
        args.output_commitments.len() == args.output_amount_commitments.len(),
        PoolError::OutputSetMismatch,
    );
    require!(
        args.output_commitments.len() == 1,
        PoolError::InvalidChangeNoteCount,
    );
    require_keys_eq!(
        ctx.accounts.mint_mapping.origin_mint,
        origin_mint,
        PoolError::OriginMintMismatch,
    );

    let destination_owner = ctx.accounts.destination_token_account.owner;

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
    let pool_account_key = pool_loader.key();
    validate_unshield_public_inputs(
        &pool_state,
        pool_account_key,
        &args,
        mode,
        destination_owner,
        fee,
    )?;
    note_ledger.ensure_capacity(total_spent)?;

    {
        let mut nullifier_set = ctx.accounts.nullifier_set.load_mut()?;
        for nullifier in &args.nullifiers {
            nullifier_set
                .insert(*nullifier)
                .map_err(|_| PoolError::NullifierReuse)?;
            emit!(PTFNullifierUsed {
                mint: origin_mint,
                nullifier: *nullifier,
            });
        }
    }

    let (new_root, _output_indices) = {
        let mut commitment_tree = ctx.accounts.commitment_tree.load_mut()?;
        commitment_tree.append_many(
            args.output_commitments.as_slice(),
            args.output_amount_commitments.as_slice(),
        )?
    };
    require!(new_root == args.new_root, PoolError::RootMismatch);
    pool_state.push_root(new_root);

    note_ledger.record_unshield(
        total_spent,
        &args.nullifiers,
        args.output_amount_commitments.as_slice(),
    )?;
    pool_state.protocol_fees = pool_state
        .protocol_fees
        .checked_add(u128::from(fee))
        .ok_or(PoolError::AmountOverflow)?;

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
            emit!(PTFUnshieldOrigin {
                mint: origin_mint,
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
            require!(
                ctx.accounts.mint_mapping.has_ptkn,
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
            let factory_accounts = ptf_factory::cpi::accounts::MintPtkn {
                factory_state: ctx.accounts.factory_state.to_account_info(),
                mint_mapping: ctx.accounts.mint_mapping.to_account_info(),
                pool_authority: ctx.accounts.pool_state.to_account_info(),
                ptkn_mint: twin_mint.to_account_info(),
                destination_token_account: ctx.accounts.destination_token_account.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            let signer = &[&signer_seeds[..]];
            let mint_ctx = CpiContext::new_with_signer(
                ctx.accounts.factory_program.to_account_info(),
                factory_accounts,
                signer,
            );
            ptf_factory::cpi::mint_ptkn(mint_ctx, args.amount)?;
            emit!(PTFUnshieldPMint {
                mint: origin_mint,
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
    let pool_key = pool_loader.key();
    let pool_bump = pool_state.bump;

    if hook_enabled {
        let (required_accounts, hook_mode, target_program) = {
            let hook_config = ctx.accounts.hook_config.load()?;
            (
                hook_config.required_keys().collect::<Vec<_>>(),
                hook_config.mode,
                hook_config.post_unshield_program_id,
            )
        };
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

            emit!(PTFHookPostUnshield {
                mint: origin_mint,
                mode: mode as u8,
                destination: destination_owner,
            });
        }
    }

    #[cfg(feature = "invariant_checks")]
    {
        enforce_supply_invariant(
            &pool_state,
            &note_ledger,
            &ctx.accounts.vault_token_account,
            ctx.accounts.twin_mint.as_ref(),
        )?;
    }
    Ok(())
}
#[cfg(feature = "invariant_checks")]
fn enforce_supply_invariant<'info>(
    pool_state: &PoolState,
    note_ledger: &NoteLedger,
    vault_token_account: &InterfaceAccount<'info, TokenAccount>,
    twin_mint: Option<&InterfaceAccount<'info, Mint>>,
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

    validate_supply_components(pool_state, note_ledger, twin_supply, vault_balance).map(|_| ())
}

#[cfg(feature = "invariant_checks")]
fn validate_supply_components(
    pool_state: &PoolState,
    note_ledger: &NoteLedger,
    twin_supply: u128,
    vault_balance: u128,
) -> Result<u128> {
    let expected = twin_supply
        .checked_add(note_ledger.live_value)
        .ok_or(PoolError::AmountOverflow)?
        .checked_add(pool_state.protocol_fees)
        .ok_or(PoolError::AmountOverflow)?;

    require!(vault_balance == expected, PoolError::InvariantBreach);
    Ok(expected)
}

fn poseidon_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let left_fr = Fr::from_le_bytes_mod_order(left);
    let right_fr = Fr::from_le_bytes_mod_order(right);
    let hash = poseidon::hash_two(&left_fr, &right_fr);
    fr_to_bytes(&hash)
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
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::NULLIFIERS, origin_mint.key().as_ref()],
        bump,
        space = NullifierSet::SPACE,
    )]
    pub nullifier_set: AccountLoader<'info, NullifierSet>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::NOTES, origin_mint.key().as_ref()],
        bump,
        space = NoteLedger::SPACE,
    )]
    pub note_ledger: AccountLoader<'info, NoteLedger>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::TREE, origin_mint.key().as_ref()],
        bump,
        space = CommitmentTree::SPACE,
    )]
    pub commitment_tree: AccountLoader<'info, CommitmentTree>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::HOOKS, origin_mint.key().as_ref()],
        bump,
        space = HookConfig::SPACE,
    )]
    pub hook_config: AccountLoader<'info, HookConfig>,
    #[account(mut)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    pub origin_mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [seeds::MINT_MAPPING, origin_mint.key().as_ref()],
        bump = mint_mapping.bump,
        seeds::program = ptf_factory::ID
    )]
    pub mint_mapping: Account<'info, MintMapping>,
    #[account(
        seeds = [seeds::FACTORY, ptf_factory::ID.as_ref()],
        bump = factory_state.bump,
        seeds::program = ptf_factory::ID
    )]
    pub factory_state: Account<'info, ptf_factory::FactoryState>,
    #[account(mut)]
    pub twin_mint: Option<InterfaceAccount<'info, Mint>>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump,
        has_one = authority
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(
        mut,
        seeds = [seeds::NULLIFIERS, pool_state.load()?.origin_mint.as_ref()],
        bump = nullifier_set.load()?.bump
    )]
    pub nullifier_set: AccountLoader<'info, NullifierSet>,
}

#[derive(Accounts)]
pub struct Shield<'info> {
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(
        seeds = [seeds::HOOKS, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.hook_config_bump,
        constraint = hook_config.load()?.pool == pool_state.key() @ PoolError::HookConfigInvalid,
    )]
    pub hook_config: AccountLoader<'info, HookConfig>,
    #[account(
        mut,
        seeds = [seeds::NULLIFIERS, pool_state.load()?.origin_mint.as_ref()],
        bump = nullifier_set.load()?.bump
    )]
    pub nullifier_set: AccountLoader<'info, NullifierSet>,
    #[account(
        mut,
        seeds = [seeds::TREE, pool_state.load()?.origin_mint.as_ref()],
        bump = commitment_tree.load()?.bump,
        constraint = commitment_tree.load()?.pool == pool_state.key() @ PoolError::CommitmentTreeMismatch
    )]
    pub commitment_tree: AccountLoader<'info, CommitmentTree>,
    #[account(
        mut,
        seeds = [seeds::NOTES, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.note_ledger_bump,
        constraint = note_ledger.key() == pool_state.load()?.note_ledger @ PoolError::NoteLedgerMismatch,
        constraint = note_ledger.load()?.pool == pool_state.key() @ PoolError::NoteLedgerMismatch,
    )]
    pub note_ledger: AccountLoader<'info, NoteLedger>,
    #[account(
        mut,
        seeds = [seeds::VAULT, pool_state.load()?.origin_mint.as_ref()],
        bump = vault_state.bump,
        seeds::program = ptf_vault::ID
    )]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub twin_mint: Option<InterfaceAccount<'info, Mint>>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(
        address = pool_state.load()?.verifying_key,
        constraint = verifying_key.hash == pool_state.load()?.verifying_key_hash @ PoolError::VerifyingKeyHashMismatch,
    )]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    pub payer: Signer<'info>,
    pub origin_mint: InterfaceAccount<'info, Mint>,
    pub vault_program: Program<'info, PtfVault>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Unshield<'info> {
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(
        seeds = [seeds::HOOKS, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.hook_config_bump,
        constraint = hook_config.load()?.pool == pool_state.key() @ PoolError::HookConfigInvalid,
    )]
    pub hook_config: AccountLoader<'info, HookConfig>,
    #[account(
        mut,
        seeds = [seeds::NULLIFIERS, pool_state.load()?.origin_mint.as_ref()],
        bump = nullifier_set.load()?.bump
    )]
    pub nullifier_set: AccountLoader<'info, NullifierSet>,
    #[account(
        mut,
        seeds = [seeds::TREE, pool_state.load()?.origin_mint.as_ref()],
        bump = commitment_tree.load()?.bump,
        constraint = commitment_tree.load()?.pool == pool_state.key() @ PoolError::CommitmentTreeMismatch
    )]
    pub commitment_tree: AccountLoader<'info, CommitmentTree>,
    #[account(
        mut,
        seeds = [seeds::NOTES, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.note_ledger_bump,
        constraint = note_ledger.key() == pool_state.load()?.note_ledger @ PoolError::NoteLedgerMismatch,
        constraint = note_ledger.load()?.pool == pool_state.key() @ PoolError::NoteLedgerMismatch,
    )]
    pub note_ledger: AccountLoader<'info, NoteLedger>,
    #[account(
        seeds = [seeds::MINT_MAPPING, pool_state.load()?.origin_mint.as_ref()],
        bump = mint_mapping.bump,
        seeds::program = ptf_factory::ID,
        constraint = mint_mapping.origin_mint == pool_state.load()?.origin_mint @ PoolError::OriginMintMismatch,
    )]
    pub mint_mapping: Account<'info, MintMapping>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(
        address = pool_state.load()?.verifying_key,
        constraint = verifying_key.hash == pool_state.load()?.verifying_key_hash @ PoolError::VerifyingKeyHashMismatch,
    )]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
    #[account(mut)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub twin_mint: Option<InterfaceAccount<'info, Mint>>,
    pub vault_program: Program<'info, PtfVault>,
    #[account(
        seeds = [seeds::FACTORY, ptf_factory::ID.as_ref()],
        bump = factory_state.bump,
        seeds::program = ptf_factory::ID
    )]
    pub factory_state: Account<'info, ptf_factory::FactoryState>,
    pub factory_program: Program<'info, PtfFactory>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ConfigureHooks<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump,
        has_one = authority
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(
        mut,
        seeds = [seeds::HOOKS, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.hook_config_bump,
        constraint = hook_config.load()?.pool == pool_state.key() @ PoolError::HookConfigInvalid,
    )]
    pub hook_config: AccountLoader<'info, HookConfig>,
}

#[derive(Accounts)]
pub struct PrivateTransfer<'info> {
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(
        mut,
        seeds = [seeds::NULLIFIERS, pool_state.load()?.origin_mint.as_ref()],
        bump = nullifier_set.load()?.bump
    )]
    pub nullifier_set: AccountLoader<'info, NullifierSet>,
    #[account(
        mut,
        seeds = [seeds::TREE, pool_state.load()?.origin_mint.as_ref()],
        bump = commitment_tree.load()?.bump,
        constraint = commitment_tree.load()?.pool == pool_state.key() @ PoolError::CommitmentTreeMismatch
    )]
    pub commitment_tree: AccountLoader<'info, CommitmentTree>,
    #[account(
        mut,
        seeds = [seeds::NOTES, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.note_ledger_bump,
        constraint = note_ledger.key() == pool_state.load()?.note_ledger @ PoolError::NoteLedgerMismatch,
        constraint = note_ledger.load()?.pool == pool_state.key() @ PoolError::NoteLedgerMismatch,
    )]
    pub note_ledger: AccountLoader<'info, NoteLedger>,
    pub verifier_program: Program<'info, PtfVerifierGroth16>,
    #[account(
        address = pool_state.load()?.verifying_key,
        constraint = verifying_key.hash == pool_state.load()?.verifying_key_hash @ PoolError::VerifyingKeyHashMismatch,
    )]
    pub verifying_key: Account<'info, VerifyingKeyAccount>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ShieldArgs {
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

#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct CommitmentTree {
    pub pool: Pubkey,
    pub canopy_depth: u8,
    pub next_index: u64,
    pub current_root: [u8; 32],
    pub frontier: [[u8; 32]; CommitmentTree::DEPTH],
    pub zeroes: [[u8; 32]; CommitmentTree::DEPTH],
    pub canopy: [[u8; 32]; CommitmentTree::MAX_CANOPY],
    pub recent_commitments: [[u8; 32]; CommitmentTree::MAX_CANOPY],
    pub recent_amount_commitments: [[u8; 32]; CommitmentTree::MAX_CANOPY],
    pub recent_indices: [u64; CommitmentTree::MAX_CANOPY],
    pub recent_len: u8,
    pub bump: u8,
}

impl CommitmentTree {
    pub const DEPTH: usize = ptf_common::MERKLE_DEPTH as usize;
    pub const MAX_CANOPY: usize = 16;
    pub const SPACE: usize = 8 + core::mem::size_of::<CommitmentTree>() + 64;
    pub const PRECOMPUTED_ZEROES: [[u8; 32]; Self::DEPTH] = [
        [
            0x64, 0x48, 0xb6, 0x46, 0x84, 0xee, 0x39, 0xa8, 0x23, 0xd5, 0xfe, 0x5f, 0xd5, 0x24,
            0x31, 0xdc, 0x81, 0xe4, 0x81, 0x7b, 0xf2, 0xc3, 0xea, 0x3c, 0xab, 0x9e, 0x23, 0x9e,
            0xfb, 0xf5, 0x98, 0x20,
        ],
        [
            0xe1, 0xf1, 0xb1, 0x60, 0x44, 0x77, 0xa4, 0x67, 0xf0, 0x8d, 0xc6, 0x9d, 0xcb, 0x44,
            0x1a, 0x26, 0xec, 0xa7, 0x84, 0xf5, 0x6f, 0x1a, 0x30, 0xdf, 0x63, 0x22, 0xb1, 0xcd,
            0x3d, 0x67, 0x69, 0x10,
        ],
        [
            0x38, 0xd2, 0x56, 0xb8, 0xb2, 0x7e, 0xd5, 0x28, 0xd5, 0x1d, 0x37, 0x50, 0xea, 0x6e,
            0x7c, 0x46, 0x06, 0x21, 0xf7, 0x50, 0x8d, 0x75, 0x3d, 0x2e, 0xaf, 0xe2, 0x7e, 0x53,
            0x31, 0x33, 0xf4, 0x18,
        ],
        [
            0x2a, 0x95, 0xbc, 0x9d, 0x55, 0x97, 0xac, 0xca, 0x65, 0x82, 0x56, 0x1a, 0x57, 0x28,
            0xb7, 0xf1, 0x45, 0x23, 0xa5, 0x3b, 0xe9, 0xff, 0x20, 0x63, 0xd3, 0xb0, 0x17, 0xcb,
            0x37, 0xd8, 0xf9, 0x07,
        ],
        [
            0x55, 0x3f, 0x18, 0x39, 0x16, 0xec, 0x5c, 0x7b, 0x4d, 0xad, 0xb2, 0x94, 0x8c, 0xc5,
            0x99, 0xa6, 0x07, 0x29, 0xf3, 0x5d, 0x4c, 0x1f, 0x63, 0xc9, 0xf5, 0xb3, 0x46, 0x87,
            0x5e, 0xcf, 0x94, 0x2b,
        ],
        [
            0x78, 0x9d, 0xa0, 0x2e, 0xa3, 0xdd, 0x11, 0x1d, 0x61, 0x53, 0xb9, 0x51, 0x69, 0x1e,
            0xd7, 0xfe, 0xbc, 0xe1, 0xa9, 0xcc, 0x22, 0x7d, 0xea, 0x46, 0x96, 0x45, 0x66, 0xa6,
            0xc5, 0x93, 0xee, 0x2d,
        ],
        [
            0x9d, 0x34, 0x87, 0x3c, 0xbe, 0xaa, 0xa4, 0xa8, 0x7f, 0xac, 0xb5, 0x8c, 0xa8, 0x15,
            0x05, 0x8b, 0x7b, 0x59, 0x39, 0xb6, 0x1e, 0x60, 0xcf, 0x82, 0xe9, 0x84, 0x2b, 0xa2,
            0xe5, 0x95, 0x82, 0x07,
        ],
        [
            0x61, 0xcc, 0xf3, 0x99, 0x3a, 0xbe, 0x4c, 0x44, 0x1a, 0x21, 0x41, 0x4a, 0x27, 0x2e,
            0x6b, 0x61, 0x2a, 0x47, 0x64, 0x45, 0x86, 0xec, 0x1b, 0x50, 0xa6, 0x27, 0x60, 0x8f,
            0xf1, 0xe5, 0xa5, 0x2f,
        ],
        [
            0x47, 0xd7, 0xfc, 0x14, 0xa6, 0x56, 0x21, 0x3e, 0xab, 0x28, 0xe2, 0xe3, 0xcc, 0x7a,
            0x5e, 0xe4, 0x66, 0x1f, 0x94, 0x9e, 0x38, 0x80, 0xb7, 0xec, 0x21, 0xfd, 0xd8, 0xd0,
            0x76, 0x43, 0x88, 0x0e,
        ],
        [
            0xf2, 0x0a, 0x19, 0xda, 0xe5, 0x75, 0x61, 0xde, 0x33, 0x35, 0x71, 0x57, 0xf9, 0x92,
            0x58, 0xf9, 0x69, 0xb4, 0x2e, 0xa5, 0xd1, 0x7a, 0x71, 0x28, 0x1e, 0x4f, 0x49, 0x72,
            0xda, 0x01, 0x72, 0x1b,
        ],
        [
            0x36, 0x76, 0x7d, 0xce, 0xfa, 0x6b, 0xbc, 0xbe, 0xb5, 0x08, 0x08, 0x65, 0xe4, 0xe1,
            0xe6, 0xa6, 0x19, 0x98, 0x24, 0x01, 0xb2, 0xc0, 0x00, 0x52, 0x38, 0x36, 0x5e, 0x72,
            0x22, 0x88, 0x8d, 0x1f,
        ],
        [
            0x5a, 0xf8, 0xb5, 0x71, 0x04, 0x9a, 0x87, 0xd0, 0xa8, 0x88, 0xcf, 0x2a, 0xa1, 0xb0,
            0x62, 0x61, 0xfb, 0xfc, 0x8c, 0xba, 0x89, 0x15, 0x70, 0xb9, 0xaf, 0x4b, 0x91, 0x6c,
            0xf6, 0x82, 0x5d, 0x2c,
        ],
        [
            0xd0, 0xbf, 0xbf, 0xe0, 0x70, 0xf2, 0x58, 0x64, 0x64, 0xf4, 0x13, 0xa1, 0xaa, 0xc4,
            0xf5, 0x4e, 0x13, 0xa1, 0x3f, 0xdf, 0x5a, 0x7f, 0x95, 0x20, 0xb8, 0x0b, 0x94, 0xa0,
            0x48, 0x41, 0xc5, 0x14,
        ],
        [
            0x0c, 0xe8, 0xeb, 0xf4, 0x4b, 0x8e, 0x11, 0x16, 0xd4, 0x89, 0xad, 0x8c, 0x58, 0x25,
            0xbe, 0x11, 0xaf, 0xb9, 0xd8, 0x44, 0xee, 0xc0, 0x10, 0x1e, 0x96, 0x6f, 0x98, 0x2f,
            0xb1, 0x33, 0x0d, 0x19,
        ],
        [
            0x92, 0x6c, 0xe0, 0x25, 0x93, 0x64, 0xb3, 0xa5, 0x0a, 0x51, 0xaf, 0x96, 0x65, 0xae,
            0x67, 0x11, 0xed, 0x73, 0xad, 0x14, 0x49, 0x35, 0x17, 0xac, 0x52, 0x41, 0x70, 0xce,
            0xa9, 0x8a, 0xf9, 0x22,
        ],
        [
            0x23, 0x73, 0xba, 0x8b, 0xd3, 0x53, 0xb7, 0xf8, 0xee, 0xcc, 0x6e, 0xc6, 0x29, 0x6f,
            0x52, 0x5a, 0x57, 0x6a, 0xbf, 0x72, 0x8d, 0x22, 0x6f, 0x9f, 0x0b, 0x88, 0xe5, 0x6c,
            0x9b, 0x7c, 0x7c, 0x2a,
        ],
        [
            0x92, 0xb9, 0x36, 0x3f, 0x64, 0xdd, 0x75, 0x4d, 0x95, 0x8b, 0x98, 0xc2, 0xc9, 0x43,
            0x00, 0x47, 0xfc, 0x3f, 0x46, 0x4d, 0xc1, 0xf9, 0x7a, 0xc6, 0xc1, 0x8e, 0x69, 0x58,
            0xe5, 0x86, 0x81, 0x2e,
        ],
        [
            0x0f, 0xf1, 0x1f, 0x1c, 0x9d, 0x24, 0x46, 0x35, 0x27, 0x92, 0x73, 0x64, 0xad, 0x6e,
            0xef, 0x8a, 0x94, 0xae, 0x0d, 0x05, 0xcf, 0xc8, 0xe2, 0x49, 0xab, 0x4e, 0x9a, 0x1e,
            0x57, 0xc5, 0x57, 0x0f,
        ],
        [
            0xca, 0x2c, 0xf7, 0x34, 0x61, 0xe3, 0x9c, 0x3c, 0xe4, 0x46, 0x7d, 0x69, 0x10, 0xe3,
            0x78, 0xfe, 0x1c, 0x0e, 0x80, 0x88, 0x43, 0x3d, 0xf6, 0xd5, 0x4a, 0x55, 0xfb, 0xb5,
            0x67, 0xee, 0x30, 0x18,
        ],
        [
            0x3e, 0x1f, 0x19, 0x22, 0xdf, 0xb6, 0x71, 0xd3, 0xf9, 0x12, 0xf7, 0xea, 0x46, 0x1e,
            0x0a, 0x88, 0xee, 0x84, 0x8f, 0xdd, 0xe1, 0x2b, 0x6c, 0x18, 0xab, 0x1a, 0xd2, 0xc5,
            0x6a, 0xe7, 0x34, 0x21,
        ],
        [
            0xb1, 0xa5, 0x91, 0xdb, 0xf3, 0x8d, 0x8f, 0x8f, 0xa8, 0x3a, 0xee, 0x58, 0xc9, 0xd8,
            0x51, 0xc0, 0xb0, 0x59, 0x38, 0xf3, 0x66, 0xd8, 0xeb, 0xfe, 0x4f, 0xbc, 0x4e, 0x84,
            0xec, 0x90, 0xdf, 0x19,
        ],
        [
            0x2b, 0xe5, 0xef, 0x22, 0xf7, 0x05, 0x8c, 0x64, 0xb4, 0x12, 0x49, 0xef, 0x93, 0x0e,
            0xaf, 0x74, 0x2d, 0x85, 0x84, 0xfd, 0xae, 0x69, 0x1e, 0x98, 0x87, 0x07, 0x5c, 0x6b,
            0xa6, 0xa2, 0xcc, 0x18,
        ],
        [
            0x8d, 0x53, 0xd2, 0x49, 0x45, 0x64, 0x05, 0xdf, 0xfa, 0x83, 0xad, 0xef, 0xf2, 0x38,
            0x83, 0x62, 0x3a, 0x47, 0x4f, 0xd5, 0xd2, 0x04, 0x13, 0x4d, 0x1b, 0x0d, 0x23, 0x15,
            0x94, 0x90, 0x88, 0x23,
        ],
        [
            0x40, 0xd5, 0x9e, 0x52, 0xe4, 0x73, 0xe6, 0x96, 0x1d, 0x0b, 0x8d, 0x9c, 0x2c, 0xaf,
            0xa2, 0x66, 0xe8, 0x4d, 0x29, 0xb5, 0x43, 0xf5, 0xe8, 0xe9, 0xc0, 0x6c, 0x7b, 0xa9,
            0xb4, 0x1f, 0x17, 0x27,
        ],
        [
            0x21, 0xae, 0xe6, 0xdd, 0x96, 0x96, 0xd5, 0xf8, 0xe5, 0x83, 0x25, 0x39, 0xb9, 0x30,
            0xb2, 0xdc, 0x28, 0x0d, 0xfc, 0x74, 0xbc, 0xa0, 0x11, 0x57, 0xfd, 0x29, 0xf6, 0x40,
            0x05, 0x65, 0xf6, 0x2f,
        ],
        [
            0x18, 0x15, 0x61, 0xce, 0x30, 0x26, 0x93, 0x69, 0x56, 0xd7, 0xad, 0xf6, 0x68, 0x51,
            0xad, 0xe0, 0xa2, 0x78, 0x77, 0x27, 0xf5, 0xf7, 0x02, 0x59, 0xe9, 0x91, 0xd4, 0x43,
            0xf1, 0x58, 0x0c, 0x12,
        ],
        [
            0x95, 0x37, 0x48, 0x79, 0xd2, 0x65, 0xd6, 0xa2, 0x1d, 0xa2, 0x65, 0xa5, 0xa0, 0x95,
            0xc4, 0x1e, 0x07, 0x03, 0xdb, 0xe5, 0xd5, 0x53, 0xf8, 0x7b, 0xb0, 0x21, 0x3f, 0x0d,
            0xb7, 0xfe, 0x21, 0x1f,
        ],
        [
            0xd2, 0x72, 0x8a, 0xe1, 0xdd, 0xa1, 0xb1, 0x8b, 0x96, 0x9e, 0x8a, 0x06, 0x68, 0xe7,
            0x26, 0xa8, 0x23, 0x86, 0x6a, 0xf6, 0xc0, 0x8c, 0x63, 0x4c, 0xe1, 0x35, 0x13, 0xa7,
            0x5f, 0x90, 0xbe, 0x24,
        ],
        [
            0x6d, 0xc2, 0xda, 0x53, 0xe5, 0x74, 0x4c, 0x74, 0x28, 0xc3, 0x65, 0x1d, 0x82, 0xf3,
            0x7e, 0x59, 0xcd, 0xd4, 0x57, 0xad, 0xde, 0xea, 0x0c, 0xc5, 0x91, 0x74, 0xd1, 0x2e,
            0xb6, 0x66, 0x86, 0x0f,
        ],
        [
            0xef, 0x59, 0x19, 0x0e, 0x23, 0x2a, 0x1a, 0x3d, 0xb4, 0x8c, 0xe0, 0x6a, 0x3f, 0x7a,
            0x7a, 0x4e, 0x59, 0x41, 0x1c, 0x1a, 0x4a, 0x3f, 0x41, 0x34, 0xb0, 0x98, 0x2d, 0xf5,
            0x6b, 0xd4, 0x18, 0x09,
        ],
        [
            0xf2, 0x5f, 0x5c, 0x37, 0xad, 0x13, 0x85, 0x12, 0x65, 0x5a, 0xfc, 0x0a, 0x0d, 0xf9,
            0x26, 0x2e, 0xfa, 0x4d, 0x40, 0x5e, 0x64, 0x17, 0x69, 0xe7, 0xcd, 0x9e, 0x47, 0x4c,
            0x1b, 0xb0, 0xbe, 0x1b,
        ],
        [
            0xd9, 0xea, 0x34, 0x97, 0x4c, 0x18, 0x8e, 0xac, 0xd5, 0x19, 0xb1, 0x2a, 0x92, 0xb9,
            0x60, 0xd5, 0x1e, 0x55, 0xf5, 0xdf, 0x61, 0x6c, 0x7a, 0xa1, 0x42, 0x7e, 0x25, 0x8e,
            0xc5, 0xa1, 0x68, 0x2f,
        ],
    ];

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
        self.recent_indices = [0u64; Self::MAX_CANOPY];
        self.recent_len = 0;
        Ok(())
    }

    pub fn append_note(
        &mut self,
        commitment: [u8; 32],
        amount_commit: [u8; 32],
    ) -> Result<([u8; 32], u64)> {
        self.insert_leaf(commitment, amount_commit)
    }

    pub fn append_many(
        &mut self,
        commitments: &[[u8; 32]],
        amount_commitments: &[[u8; 32]],
    ) -> Result<([u8; 32], Vec<u64>)> {
        if commitments.is_empty() {
            return Ok((self.current_root, Vec::new()));
        }
        require!(
            commitments.len() == amount_commitments.len(),
            PoolError::OutputSetMismatch,
        );
        let mut root = self.current_root;
        let mut indices = Vec::with_capacity(commitments.len());
        for (commitment, amount_commit) in commitments.iter().zip(amount_commitments.iter()) {
            let (new_root, index) = self.insert_leaf(*commitment, *amount_commit)?;
            root = new_root;
            indices.push(index);
        }
        Ok((root, indices))
    }

    fn insert_leaf(
        &mut self,
        commitment: [u8; 32],
        amount_commit: [u8; 32],
    ) -> Result<([u8; 32], u64)> {
        require!(
            self.next_index < (1u128 << Self::DEPTH) as u64,
            PoolError::TreeFull,
        );
        let index_position = self.next_index;
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
        self.record_recent(index_position, commitment, amount_commit);
        Ok((self.current_root, index_position))
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

    fn record_recent(&mut self, index: u64, commitment: [u8; 32], amount_commit: [u8; 32]) {
        if (self.recent_len as usize) < Self::MAX_CANOPY {
            let idx = self.recent_len as usize;
            self.recent_commitments[idx] = commitment;
            self.recent_amount_commitments[idx] = amount_commit;
            self.recent_indices[idx] = index;
            self.recent_len += 1;
        } else {
            for idx in 1..Self::MAX_CANOPY {
                self.recent_commitments[idx - 1] = self.recent_commitments[idx];
                self.recent_amount_commitments[idx - 1] = self.recent_amount_commitments[idx];
                self.recent_indices[idx - 1] = self.recent_indices[idx];
            }
            self.recent_commitments[Self::MAX_CANOPY - 1] = commitment;
            self.recent_amount_commitments[Self::MAX_CANOPY - 1] = amount_commit;
            self.recent_indices[Self::MAX_CANOPY - 1] = index;
        }
    }

    fn compute_zeroes() -> [[u8; 32]; Self::DEPTH] {
        Self::PRECOMPUTED_ZEROES
    }
}

#[account(zero_copy(unsafe))]
#[repr(C)]
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
    pub recent_roots: [[u8; 32]; PoolState::MAX_ROOTS],
    pub roots_len: u8,
    pub fee_bps: u16,
    pub features: FeatureFlags,
    pub note_ledger: Pubkey,
    pub note_ledger_bump: u8,
    pub protocol_fees: u128,
    pub hook_config: Pubkey,
    pub hook_config_present: bool,
    pub hook_config_bump: u8,
    pub bump: u8,
    pub twin_mint: Pubkey,
    pub twin_mint_enabled: bool,
}

impl PoolState {
    pub const MAX_ROOTS: usize = 16;
    pub const SPACE: usize = 8 + core::mem::size_of::<PoolState>() + 64;

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

#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct NullifierSet {
    pub pool: Pubkey,
    pub count: u32,
    pub entries: [[u8; 32]; NullifierSet::MAX_NULLIFIERS],
    pub bloom: [u8; NullifierSet::BLOOM_BYTES],
    pub bump: u8,
}

impl NullifierSet {
    pub const MAX_NULLIFIERS: usize = 256;
    pub const BLOOM_BYTES: usize = 512;
    pub const SPACE: usize = 8 + core::mem::size_of::<NullifierSet>() + 64;

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

#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct NoteLedger {
    pub pool: Pubkey,
    pub total_minted: u128,
    pub total_spent: u128,
    pub live_value: u128,
    pub notes_created: u64,
    pub notes_consumed: u64,
    pub amount_commitment_digest: [u8; 32],
    pub nullifier_digest: [u8; 32],
    pub bump: u8,
}

impl NoteLedger {
    pub const SPACE: usize = 8 + core::mem::size_of::<NoteLedger>() + 64;

    pub fn init(&mut self, pool: Pubkey, bump: u8) {
        self.pool = pool;
        self.total_minted = 0;
        self.total_spent = 0;
        self.live_value = 0;
        self.notes_created = 0;
        self.notes_consumed = 0;
        self.amount_commitment_digest = [0u8; 32];
        self.nullifier_digest = [0u8; 32];
        self.bump = bump;
    }

    #[cfg_attr(not(feature = "note_digests"), allow(unused_variables))]
    pub fn record_shield(&mut self, amount: u64, amount_commit: [u8; 32]) -> Result<()> {
        self.total_minted = self
            .total_minted
            .checked_add(u128::from(amount))
            .ok_or(PoolError::AmountOverflow)?;
        self.live_value = self
            .live_value
            .checked_add(u128::from(amount))
            .ok_or(PoolError::AmountOverflow)?;
        self.notes_created = self
            .notes_created
            .checked_add(1)
            .ok_or(PoolError::AmountOverflow)?;
        #[cfg(feature = "note_digests")]
        self.absorb_amount_commitments(core::slice::from_ref(&amount_commit));
        Ok(())
    }

    pub fn record_transfer(
        &mut self,
        nullifiers: &[[u8; 32]],
        amount_commitments: &[[u8; 32]],
    ) -> Result<()> {
        if !nullifiers.is_empty() {
            #[cfg(feature = "note_digests")]
            self.absorb_nullifiers(nullifiers);
            self.notes_consumed = self
                .notes_consumed
                .checked_add(nullifiers.len() as u64)
                .ok_or(PoolError::AmountOverflow)?;
        }
        if !amount_commitments.is_empty() {
            #[cfg(feature = "note_digests")]
            self.absorb_amount_commitments(amount_commitments);
            self.notes_created = self
                .notes_created
                .checked_add(amount_commitments.len() as u64)
                .ok_or(PoolError::AmountOverflow)?;
        }
        Ok(())
    }

    pub fn record_unshield(
        &mut self,
        total_spent: u64,
        nullifiers: &[[u8; 32]],
        output_amount_commitments: &[[u8; 32]],
    ) -> Result<()> {
        self.total_spent = self
            .total_spent
            .checked_add(u128::from(total_spent))
            .ok_or(PoolError::AmountOverflow)?;
        self.live_value = self
            .live_value
            .checked_sub(u128::from(total_spent))
            .ok_or(PoolError::InsufficientLiquidity)?;
        if !nullifiers.is_empty() {
            #[cfg(feature = "note_digests")]
            self.absorb_nullifiers(nullifiers);
            self.notes_consumed = self
                .notes_consumed
                .checked_add(nullifiers.len() as u64)
                .ok_or(PoolError::AmountOverflow)?;
        }
        if !output_amount_commitments.is_empty() {
            #[cfg(feature = "note_digests")]
            self.absorb_amount_commitments(output_amount_commitments);
            self.notes_created = self
                .notes_created
                .checked_add(output_amount_commitments.len() as u64)
                .ok_or(PoolError::AmountOverflow)?;
        }
        Ok(())
    }

    pub fn ensure_capacity(&self, amount: u64) -> Result<()> {
        require!(
            self.live_value >= u128::from(amount),
            PoolError::InsufficientLiquidity
        );
        Ok(())
    }

    #[cfg(feature = "note_digests")]
    fn absorb_amount_commitments(&mut self, commits: &[[u8; 32]]) {
        for commit in commits {
            self.amount_commitment_digest = digest_pair(self.amount_commitment_digest, *commit);
        }
    }

    #[cfg(feature = "note_digests")]
    fn absorb_nullifiers(&mut self, nullifiers: &[[u8; 32]]) {
        for nullifier in nullifiers {
            self.nullifier_digest = digest_pair(self.nullifier_digest, *nullifier);
        }
    }
}

#[cfg(feature = "note_digests")]
fn digest_pair(seed: [u8; 32], value: [u8; 32]) -> [u8; 32] {
    poseidon_hash(&seed, &value)
}

fn parse_field_elements(bytes: &[u8]) -> Result<Vec<[u8; 32]>> {
    require!(bytes.len() % 32 == 0, PoolError::InvalidPublicInputs);
    let mut elements = Vec::with_capacity(bytes.len() / 32);
    for chunk in bytes.chunks(32) {
        let mut elem = [0u8; 32];
        elem.copy_from_slice(chunk);
        elements.push(elem);
    }
    Ok(elements)
}

fn u64_to_field_bytes(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&value.to_le_bytes());
    out
}

fn u8_to_field_bytes(value: u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0] = value;
    out
}

fn validate_unshield_public_inputs(
    pool_state: &PoolState,
    pool_key: Pubkey,
    args: &UnshieldArgs,
    mode: UnshieldMode,
    destination: Pubkey,
    fee: u64,
) -> Result<()> {
    let fields = parse_field_elements(&args.public_inputs)?;
    let change_outputs = args.output_commitments.len();
    let expected_len = 2 + args.nullifiers.len() + (2 * change_outputs) + 6;
    require!(fields.len() == expected_len, PoolError::InvalidPublicInputs);

    if fields[0] != args.old_root {
        return err!(PoolError::PublicInputMismatch);
    }
    if fields[1] != args.new_root {
        return err!(PoolError::PublicInputMismatch);
    }

    for (expected, actual) in args
        .nullifiers
        .iter()
        .zip(&fields[2..2 + args.nullifiers.len()])
    {
        if actual != expected {
            return err!(PoolError::PublicInputMismatch);
        }
    }

    let mut index = 2 + args.nullifiers.len();
    for (expected, actual) in args
        .output_commitments
        .iter()
        .zip(&fields[index..index + change_outputs])
    {
        if actual != expected {
            return err!(PoolError::PublicInputMismatch);
        }
    }
    index += change_outputs;

    for (expected, actual) in args
        .output_amount_commitments
        .iter()
        .zip(&fields[index..index + change_outputs])
    {
        if actual != expected {
            return err!(PoolError::PublicInputMismatch);
        }
    }
    index += change_outputs;

    if fields[index] != u64_to_field_bytes(args.amount) {
        return err!(PoolError::PublicInputMismatch);
    }
    index += 1;
    if fields[index] != u64_to_field_bytes(fee) {
        return err!(PoolError::PublicInputMismatch);
    }
    index += 1;
    if fields[index] != destination.to_bytes() {
        return err!(PoolError::PublicInputMismatch);
    }
    index += 1;
    if fields[index] != u8_to_field_bytes(mode as u8) {
        return err!(PoolError::PublicInputMismatch);
    }
    index += 1;
    if fields[index] != pool_state.origin_mint.to_bytes() {
        return err!(PoolError::PublicInputMismatch);
    }
    index += 1;
    if fields[index] != pool_key.to_bytes() {
        return err!(PoolError::PublicInputMismatch);
    }

    Ok(())
}

#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct HookConfig {
    pub pool: Pubkey,
    pub post_shield_program_id: Pubkey,
    pub post_unshield_program_id: Pubkey,
    pub required_accounts: [[u8; 32]; HookConfig::MAX_REQUIRED_ACCOUNTS],
    pub required_accounts_len: u8,
    pub mode: HookAccountMode,
    pub bump: u8,
}

impl HookConfig {
    pub const MAX_REQUIRED_ACCOUNTS: usize = 8;
    pub const SPACE: usize = 8 + core::mem::size_of::<HookConfig>() + 64;

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
pub struct PTFShielded {
    pub mint: Pubkey,
    pub depositor: Pubkey,
    pub commitment: [u8; 32],
    pub root: [u8; 32],
    pub amount_commit: [u8; 32],
}

#[event]
pub struct PTFUnshieldOrigin {
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct PTFUnshieldPMint {
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct PTFHookPostUnshield {
    pub mint: Pubkey,
    pub mode: u8,
    pub destination: Pubkey,
}

#[event]
pub struct PTFHookPostShield {
    pub mint: Pubkey,
    pub deposit_id: u64,
    pub commitment: [u8; 32],
}

#[event]
pub struct PTFTransferred {
    pub mint: Pubkey,
    pub inputs: Vec<[u8; 32]>,
    pub outputs: Vec<[u8; 32]>,
    pub root: [u8; 32],
}

#[event]
pub struct PTFNullifierUsed {
    pub mint: Pubkey,
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
pub struct PTFInvariantOk {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub supply_pm: u64,
    pub live_notes_commit: [u8; 32],
    pub fees: u128,
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

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum HookAccountMode {
    Strict = 0,
    Lenient = 1,
}

#[error_code]
pub enum PoolError {
    #[msg("E_INVALID_FEE_BPS")]
    InvalidFeeBps,
    #[msg("E_VERIFIER_MISMATCH")]
    VerifierMismatch,
    #[msg("E_VERIFYING_KEY_HASH_MISMATCH")]
    VerifyingKeyHashMismatch,
    #[msg("E_INVALID_PUBLIC_INPUTS")]
    InvalidPublicInputs,
    #[msg("E_PUBLIC_INPUT_MISMATCH")]
    PublicInputMismatch,
    #[msg("E_UNKNOWN_ROOT")]
    UnknownRoot,
    #[msg("E_NULLIFIER_REUSE")]
    NullifierReuse,
    #[msg("E_NULLIFIER_CAPACITY")]
    NullifierCapacity,
    #[msg("E_AMOUNT_OVERFLOW")]
    AmountOverflow,
    #[msg("E_INSUFFICIENT_LIQUIDITY")]
    InsufficientLiquidity,
    #[msg("E_FEATURE_DISABLED")]
    FeatureDisabled,
    #[msg("E_VAULT_AUTHORITY_MISMATCH")]
    MismatchedVaultAuthority,
    #[msg("E_ORIGIN_MINT_MISMATCH")]
    OriginMintMismatch,
    #[msg("E_VAULT_TOKEN_ACCOUNT_MISMATCH")]
    VaultTokenAccountMismatch,
    #[msg("E_INVALID_DEPOSITOR_ACCOUNT")]
    InvalidDepositorAccount,
    #[msg("E_TWIN_MINT_MISMATCH")]
    TwinMintMismatch,
    #[msg("E_TWIN_MINT_NOT_CONFIGURED")]
    TwinMintNotConfigured,
    #[msg("E_TWIN_MINT_AUTHORITY_MISMATCH")]
    TwinMintAuthorityMismatch,
    #[msg("E_TWIN_MINT_DECIMALS_MISMATCH")]
    TwinMintDecimalsMismatch,
    #[msg("E_INVARIANT_BREACH")]
    InvariantBreach,
    #[msg("E_HOOKS_DISABLED")]
    HooksDisabled,
    #[msg("E_TOO_MANY_HOOK_ACCOUNTS")]
    TooManyHookAccounts,
    #[msg("E_HOOK_CONFIG_INVALID")]
    HookConfigInvalid,
    #[msg("E_HOOK_ACCOUNT_MISMATCH")]
    HookAccountMismatch,
    #[msg("E_HOOK_ACCOUNT_MISSING")]
    HookAccountMissing,
    #[msg("E_HOOK_ACCOUNT_UNEXPECTED")]
    HookAccountUnexpected,
    #[msg("E_NOTE_LEDGER_MISMATCH")]
    NoteLedgerMismatch,
    #[msg("E_TREE_MISMATCH")]
    CommitmentTreeMismatch,
    #[msg("E_INVALID_CHANGE_NOTE_COUNT")]
    InvalidChangeNoteCount,
    #[msg("E_OUTPUT_SET_MISMATCH")]
    OutputSetMismatch,
    #[msg("E_CANOPY_DEPTH_INVALID")]
    CanopyDepthInvalid,
    #[msg("E_TREE_FULL")]
    TreeFull,
    #[msg("E_ROOT_MISMATCH")]
    RootMismatch,
}

fn validate_hook_accounts(
    required_accounts: &[Pubkey],
    mode: HookAccountMode,
    remaining_accounts: &[AccountInfo<'_>],
) -> Result<()> {
    let provided: Vec<Pubkey> = remaining_accounts
        .iter()
        .map(|account| account.key())
        .collect();
    validate_hook_keys(required_accounts, mode, &provided)
}

fn validate_hook_keys(
    required_accounts: &[Pubkey],
    mode: HookAccountMode,
    provided_accounts: &[Pubkey],
) -> Result<()> {
    match mode {
        HookAccountMode::Strict => {
            require!(
                provided_accounts.len() == required_accounts.len(),
                PoolError::HookAccountMismatch
            );
            for (expected, provided) in required_accounts.iter().zip(provided_accounts.iter()) {
                require_keys_eq!(*expected, *provided, PoolError::HookAccountMismatch);
            }
        }
        HookAccountMode::Lenient => {
            for expected in required_accounts {
                require!(
                    provided_accounts.iter().any(|account| account == expected),
                    PoolError::HookAccountMissing
                );
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::InterfaceAccount;
    use anchor_lang::solana_program::{
        account_info::AccountInfo, entrypoint::ProgramResult, program_pack::Pack,
    };
    use anchor_spl::token::spl_token;
    use anchor_spl::token::spl_token::state::{
        Account as SplAccountState, AccountState, Mint as SplMintState,
    };
    use anchor_spl::token_interface::{Mint as InterfaceMint, TokenAccount};

    #[test]
    fn strict_mode_requires_exact_accounts() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        assert!(validate_hook_keys(&[a, b], HookAccountMode::Strict, &[a, b]).is_ok());
        assert!(validate_hook_keys(&[a, b], HookAccountMode::Strict, &[b, a]).is_err());
        assert!(validate_hook_keys(&[a, b], HookAccountMode::Strict, &[a]).is_err());
    }

    #[test]
    fn lenient_mode_requires_subset_only() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let c = Pubkey::new_unique();
        assert!(validate_hook_keys(&[a, b], HookAccountMode::Lenient, &[c, a, b]).is_ok());
        assert!(validate_hook_keys(&[a, b], HookAccountMode::Lenient, &[c, a]).is_err());
    }

    #[test]
    fn pool_state_space_matches_struct_size() {
        assert!(
            PoolState::SPACE >= core::mem::size_of::<PoolState>(),
            "SPACE {} must accomodate struct size {}",
            PoolState::SPACE,
            core::mem::size_of::<PoolState>()
        );
    }

    #[cfg(feature = "invariant_checks")]
    #[test]
    fn supply_invariant_tracks_origin_flow() {
        let pool_key = Pubkey::new_unique();
        let mut pool_state = dummy_pool_state(false);
        let mut ledger = dummy_note_ledger(pool_key);
        let mut vault_harness = TokenAccountHarness::new(pool_state.vault, pool_state.origin_mint);

        ledger
            .record_shield(400, random_bytes(1))
            .expect("shield should succeed");
        vault_harness.set_amount(400);

        {
            let vault_account = vault_harness.interface_account();
            validate_supply_components(&pool_state, &ledger, 0, u128::from(vault_account.amount))
                .expect("initial shield balances must align");
            enforce_supply_invariant(&pool_state, &ledger, &vault_account, None)
                .expect("invariant should hold after shield");
        }

        ledger
            .record_transfer(&[random_bytes(2)], &[random_bytes(3), random_bytes(4)])
            .expect("transfer accounting must succeed");
        {
            let vault_account = vault_harness.interface_account();
            validate_supply_components(&pool_state, &ledger, 0, u128::from(vault_account.amount))
                .expect("transfer should not disturb totals");
        }

        ledger
            .record_unshield(155, &[random_bytes(5)], &[random_bytes(6)])
            .expect("unshield accounting must succeed");
        pool_state.protocol_fees = 5;
        vault_harness.set_amount(250);

        assert_eq!(ledger.live_value, 245);
        {
            let vault_account = vault_harness.interface_account();
            validate_supply_components(&pool_state, &ledger, 0, u128::from(vault_account.amount))
                .expect("origin invariant must hold");
            enforce_supply_invariant(&pool_state, &ledger, &vault_account, None)
                .expect("origin invariant should pass");
        }
    }

    #[cfg(feature = "invariant_checks")]
    #[test]
    fn supply_invariant_tracks_twin_flow() {
        let pool_key = Pubkey::new_unique();
        let mut pool_state = dummy_pool_state(true);
        let mut ledger = dummy_note_ledger(pool_key);
        let mut vault_harness = TokenAccountHarness::new(pool_state.vault, pool_state.origin_mint);

        ledger
            .record_shield(720, random_bytes(7))
            .expect("shield should succeed");
        vault_harness.set_amount(720);

        let mut twin_supply = 0u128;
        validate_supply_components(&pool_state, &ledger, twin_supply, {
            let vault_account = vault_harness.interface_account();
            u128::from(vault_account.amount)
        })
        .expect("initial twin shield should balance");

        ledger
            .record_transfer(&[random_bytes(8)], &[random_bytes(9)])
            .expect("transfer accounting must succeed");

        ledger
            .record_unshield(306, &[random_bytes(10)], &[random_bytes(11)])
            .expect("unshield accounting must succeed");
        pool_state.protocol_fees = 6;
        twin_supply += 300;
        assert_eq!(ledger.live_value, 414);
        let mut mint_harness = MintHarness::new(pool_state.twin_mint, twin_supply as u64, 6);
        mint_harness.set_supply(twin_supply as u64);

        validate_supply_components(&pool_state, &ledger, twin_supply, {
            let vault_account = vault_harness.interface_account();
            u128::from(vault_account.amount)
        })
        .expect("twin invariant must hold");
        {
            let vault_account = vault_harness.interface_account();
            let mint_account = mint_harness.interface_account();
            enforce_supply_invariant(&pool_state, &ledger, &vault_account, Some(&mint_account))
                .expect("twin invariant should pass");
        }
    }

    fn dummy_pool_state(twin_enabled: bool) -> PoolState {
        let twin_mint = if twin_enabled {
            Pubkey::new_unique()
        } else {
            Pubkey::default()
        };
        PoolState {
            authority: Pubkey::new_unique(),
            origin_mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            verifier_program: Pubkey::new_unique(),
            verifying_key: Pubkey::new_unique(),
            commitment_tree: Pubkey::new_unique(),
            verifying_key_id: [0u8; 32],
            verifying_key_hash: [0u8; 32],
            current_root: [0u8; 32],
            recent_roots: [[0u8; 32]; PoolState::MAX_ROOTS],
            roots_len: 0,
            fee_bps: 5,
            features: FeatureFlags::from(0),
            note_ledger: Pubkey::new_unique(),
            note_ledger_bump: 0,
            protocol_fees: 0,
            hook_config: Pubkey::new_unique(),
            hook_config_present: false,
            hook_config_bump: 0,
            bump: 255,
            twin_mint,
            twin_mint_enabled: twin_enabled,
        }
    }

    fn dummy_note_ledger(pool: Pubkey) -> NoteLedger {
        NoteLedger {
            pool,
            total_minted: 0,
            total_spent: 0,
            live_value: 0,
            notes_created: 0,
            notes_consumed: 0,
            amount_commitment_digest: [0u8; 32],
            nullifier_digest: [0u8; 32],
            bump: 0,
        }
    }

    fn random_bytes(seed: u8) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (idx, byte) in out.iter_mut().enumerate() {
            *byte = seed.wrapping_add(idx as u8);
        }
        out
    }

    struct MintHarness {
        account_info: &'static AccountInfo<'static>,
        data_ptr: *mut u8,
        data_len: usize,
        state: SplMintState,
    }

    impl MintHarness {
        fn new(key: Pubkey, supply: u64, decimals: u8) -> Self {
            let mut state = SplMintState::default();
            state.supply = supply;
            state.decimals = decimals;
            state.is_initialized = true;

            let mut buffer = vec![0u8; SplMintState::LEN];
            SplMintState::pack(state, &mut buffer).expect("pack mint");
            let data_box = buffer.into_boxed_slice();
            let data_len = data_box.len();
            let data_slice = Box::leak(data_box);
            let data_ptr = data_slice.as_mut_ptr();
            let lamports = Box::leak(Box::new(0u64));
            let account_info_value = AccountInfo::new(
                Box::leak(Box::new(key)),
                false,
                false,
                lamports,
                data_slice,
                Box::leak(Box::new(spl_token::id())),
                false,
                0,
            );
            let account_info = Box::leak(Box::new(account_info_value));

            Self {
                account_info,
                data_ptr,
                data_len,
                state,
            }
        }

        fn set_supply(&mut self, supply: u64) {
            self.state.supply = supply;
        }

        fn interface_account(&mut self) -> InterfaceAccount<'static, InterfaceMint> {
            unsafe {
                let data_slice = std::slice::from_raw_parts_mut(self.data_ptr, self.data_len);
                SplMintState::pack(self.state.clone(), data_slice).expect("pack mint");
            }
            InterfaceAccount::try_from(self.account_info).expect("mint account should deserialize")
        }
    }

    struct TokenAccountHarness {
        account_info: &'static AccountInfo<'static>,
        data_ptr: *mut u8,
        data_len: usize,
        state: SplAccountState,
    }

    impl TokenAccountHarness {
        fn new(owner: Pubkey, mint: Pubkey) -> Self {
            let mut state = SplAccountState::default();
            state.owner = owner;
            state.mint = mint;
            state.state = AccountState::Initialized;

            let mut buffer = vec![0u8; SplAccountState::LEN];
            SplAccountState::pack(state, &mut buffer).expect("pack token account");
            let data_box = buffer.into_boxed_slice();
            let data_len = data_box.len();
            let data_slice = Box::leak(data_box);
            let data_ptr = data_slice.as_mut_ptr();
            let lamports = Box::leak(Box::new(0u64));
            let key = Box::leak(Box::new(Pubkey::new_unique()));
            let account_info_value = AccountInfo::new(
                key,
                false,
                false,
                lamports,
                data_slice,
                Box::leak(Box::new(spl_token::id())),
                false,
                0,
            );
            let account_info = Box::leak(Box::new(account_info_value));

            Self {
                account_info,
                data_ptr,
                data_len,
                state,
            }
        }

        fn set_amount(&mut self, amount: u64) {
            self.state.amount = amount;
        }

        fn interface_account(&mut self) -> InterfaceAccount<'static, TokenAccount> {
            unsafe {
                let data_slice = std::slice::from_raw_parts_mut(self.data_ptr, self.data_len);
                SplAccountState::pack(self.state.clone(), data_slice).expect("pack token account");
            }
            InterfaceAccount::try_from(self.account_info).expect("token account should deserialize")
        }
    }

    #[cfg(feature = "integration-tests")]
    mod integration {
        use super::*;
        use anchor_lang::prelude::Rent;
        use anchor_lang::{
            prelude::AccountInfo, AccountDeserialize, InstructionData, ToAccountMetas,
        };
        use ark_bn254::{Bn254, Fr};
        use ark_groth16::{Groth16, Parameters};
        use ark_relations::r1cs::{
            ConstraintSynthesizer, ConstraintSystemRef, LinearCombination, SynthesisError, Variable,
        };
        use ark_serialize::CanonicalSerialize;
        use ark_snark::SNARK;
        use ark_std::rand::{rngs::StdRng, SeedableRng};
        use ptf_common::{seeds, FEATURE_HOOKS_ENABLED, FEATURE_PRIVATE_TRANSFER_ENABLED};
        use sha3::Keccak256;
        use solana_program::instruction::AccountMeta;
        use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
        use solana_sdk::{
            instruction::Instruction,
            signature::Keypair,
            signer::Signer,
            system_instruction, system_program,
            transaction::{Transaction, TransactionError},
        };
        use spl_associated_token_account::{
            get_associated_token_address, instruction as ata_instruction,
        };
        use spl_token::state::{Account as SplAccount, Mint as SplMint};
        use std::result::Result as StdResult;

        const IDENTITY_PUBLIC_INPUTS: usize = 16;

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

        struct IdentityFixture {
            params: Parameters<Bn254>,
            verifying_key: Vec<u8>,
            verifying_key_hash: [u8; 32],
            verifying_key_id: [u8; 32],
            seed: std::cell::RefCell<u64>,
        }

        impl IdentityFixture {
            fn new() -> Self {
                let mut rng = StdRng::seed_from_u64(7);
                let params = Groth16::<Bn254>::generate_random_parameters_with_reduction(
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

                Self {
                    params,
                    verifying_key: vk_bytes,
                    verifying_key_hash: hash,
                    verifying_key_id: hash,
                    seed: std::cell::RefCell::new(11),
                }
            }

            fn proof(&self, public_inputs: &[Fr]) -> (Vec<u8>, Vec<u8>) {
                assert_eq!(public_inputs.len(), IDENTITY_PUBLIC_INPUTS);
                let mut seed = self.seed.borrow_mut();
                let current = *seed;
                *seed += 1;
                drop(seed);
                let mut rng = StdRng::seed_from_u64(current);
                let proof = Groth16::<Bn254>::prove(
                    &self.params,
                    IdentityCircuit {
                        public: public_inputs.to_vec(),
                    },
                    &mut rng,
                )
                .expect("prove identity");

                let mut proof_bytes = Vec::new();
                proof
                    .serialize_uncompressed(&mut proof_bytes)
                    .expect("serialize proof");

                let mut public_bytes = Vec::new();
                public_inputs
                    .to_vec()
                    .serialize_uncompressed(&mut public_bytes)
                    .expect("serialize inputs");

                (proof_bytes, public_bytes)
            }
        }

        struct PoolSetup {
            pool_state: Pubkey,
            nullifier_set: Pubkey,
            note_ledger: Pubkey,
            commitment_tree: Pubkey,
            hook_config: Pubkey,
            vault_state: Pubkey,
            vault_token_account: Pubkey,
            depositor_token_account: Pubkey,
            mint_mapping: Pubkey,
            factory_state: Pubkey,
            verifier_state: Pubkey,
            origin_mint: Keypair,
            vault_token: Keypair,
            circuit_tag: [u8; 32],
            version: u8,
        }

        mod hook_stub {
            use super::*;

            pub const ID: Pubkey = Pubkey::new_from_array([42u8; 32]);

            pub fn process_instruction(
                _program_id: &Pubkey,
                _accounts: &[AccountInfo],
                data: &[u8],
            ) -> ProgramResult {
                let _hook: ptf_common::hooks::HookInstruction =
                    ptf_common::hooks::HookInstruction::try_from_slice(data)?;
                Ok(())
            }
        }

        #[cfg(feature = "full_tree")]
        #[tokio::test]
        async fn shield_transfer_unshield_flow() {
            let fixture = IdentityFixture::new();
            let (mut context, setup) = setup_pool_test(&fixture).await;

            let mut tree: CommitmentTree = fetch_account(&mut context, setup.commitment_tree).await;
            let mut ledger: NoteLedger = fetch_account(&mut context, setup.note_ledger).await;
            let mut pool_state: PoolState = fetch_account(&mut context, setup.pool_state).await;

            let amount: u64 = 1_000_000;
            let commitment = [1u8; 32];
            let amount_commit = [2u8; 32];
            let (new_root, _) = tree.append_note(commitment, amount_commit).unwrap();
            ledger.record_shield(amount, amount_commit).unwrap();

            let zeros = vec![Fr::from(0u64); IDENTITY_PUBLIC_INPUTS];
            let (proof_bytes, public_inputs) = fixture.proof(&zeros);

            let shield_ix = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::Shield {
                    pool_state: setup.pool_state,
                    hook_config: setup.hook_config,
                    nullifier_set: setup.nullifier_set,
                    commitment_tree: setup.commitment_tree,
                    note_ledger: setup.note_ledger,
                    vault_state: setup.vault_state,
                    vault_token_account: setup.vault_token_account,
                    depositor_token_account: setup.depositor_token_account,
                    twin_mint: None,
                    verifier_program: ptf_verifier_groth16::id(),
                    verifying_key: setup.verifier_state,
                    payer: context.payer.pubkey(),
                    origin_mint: setup.origin_mint.pubkey(),
                    vault_program: ptf_vault::id(),
                    token_program: spl_token::id(),
                }
                .to_account_metas(None),
                data: crate::instruction::Shield {
                    args: ShieldArgs {
                        new_root,
                        commitment,
                        amount_commit,
                        amount,
                        proof: proof_bytes.clone(),
                        public_inputs: public_inputs.clone(),
                    },
                }
                .data(),
            };
            process_instruction(&mut context, shield_ix, &[])
                .await
                .expect("shield");

            let vault_after = get_token_balance(&mut context, setup.vault_token_account).await;
            assert_eq!(vault_after, amount);

            pool_state.push_root(new_root);

            let set_features_ix = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::UpdateAuthority {
                    authority: context.payer.pubkey(),
                    pool_state: setup.pool_state,
                    nullifier_set: setup.nullifier_set,
                }
                .to_account_metas(None),
                data: crate::instruction::SetFeatures {
                    features: FEATURE_PRIVATE_TRANSFER_ENABLED,
                }
                .data(),
            };
            process_instruction(&mut context, set_features_ix, &[])
                .await
                .expect("set features");

            let old_root = tree.current_root;
            let outputs = vec![[3u8; 32], [4u8; 32]];
            let output_amounts = vec![[5u8; 32], [6u8; 32]];
            let (transfer_root, _) = tree.append_many(&outputs, &output_amounts).unwrap();
            ledger
                .record_transfer(&[], &output_amounts)
                .expect("ledger transfer");

            let transfer_ix = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::PrivateTransfer {
                    pool_state: setup.pool_state,
                    nullifier_set: setup.nullifier_set,
                    commitment_tree: setup.commitment_tree,
                    note_ledger: setup.note_ledger,
                    verifier_program: ptf_verifier_groth16::id(),
                    verifying_key: setup.verifier_state,
                }
                .to_account_metas(None),
                data: crate::instruction::PrivateTransfer {
                    args: TransferArgs {
                        old_root,
                        new_root: transfer_root,
                        nullifiers: vec![],
                        output_commitments: outputs.clone(),
                        output_amount_commitments: output_amounts.clone(),
                        proof: proof_bytes.clone(),
                        public_inputs: public_inputs.clone(),
                    },
                }
                .data(),
            };
            process_instruction(&mut context, transfer_ix, &[])
                .await
                .expect("transfer");

            pool_state.push_root(transfer_root);

            let nullifier = [7u8; 32];
            let unshield_outputs = vec![[8u8; 32]];
            let unshield_amount_commits = vec![[9u8; 32]];
            let (unshield_root, _) = tree
                .append_many(&unshield_outputs, &unshield_amount_commits)
                .unwrap();

            let fee = pool_state.calculate_fee(amount).unwrap();
            ledger
                .record_unshield(amount + fee, &[nullifier], &unshield_amount_commits)
                .expect("ledger unshield");

            let mut public_fields = build_unshield_fields(
                &pool_state,
                setup.pool_state,
                transfer_root,
                unshield_root,
                &[nullifier],
                &unshield_outputs,
                &unshield_amount_commits,
                amount,
                fee,
                context.payer.pubkey(),
                UnshieldMode::Origin,
            );
            while public_fields.len() < IDENTITY_PUBLIC_INPUTS {
                public_fields.push(Fr::from(0u64));
            }
            let (unshield_proof, unshield_inputs) = fixture.proof(&public_fields);

            let unshield_ix = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::Unshield {
                    pool_state: setup.pool_state,
                    hook_config: setup.hook_config,
                    nullifier_set: setup.nullifier_set,
                    commitment_tree: setup.commitment_tree,
                    note_ledger: setup.note_ledger,
                    mint_mapping: setup.mint_mapping,
                    verifier_program: ptf_verifier_groth16::id(),
                    verifying_key: setup.verifier_state,
                    vault_state: setup.vault_state,
                    vault_token_account: setup.vault_token_account,
                    destination_token_account: setup.depositor_token_account,
                    twin_mint: None,
                    vault_program: ptf_vault::id(),
                    factory_state: setup.factory_state,
                    factory_program: ptf_factory::id(),
                    token_program: spl_token::id(),
                }
                .to_account_metas(None),
                data: crate::instruction::UnshieldToOrigin {
                    args: UnshieldArgs {
                        old_root: transfer_root,
                        new_root: unshield_root,
                        nullifiers: vec![nullifier],
                        output_commitments: unshield_outputs.clone(),
                        output_amount_commitments: unshield_amount_commits.clone(),
                        amount,
                        proof: unshield_proof,
                        public_inputs: unshield_inputs,
                    },
                }
                .data(),
            };
            process_instruction(&mut context, unshield_ix, &[])
                .await
                .expect("unshield");

            let vault_final = get_token_balance(&mut context, setup.vault_token_account).await;
            assert_eq!(vault_final, 0);

            let ledger_account: NoteLedger = fetch_account(&mut context, setup.note_ledger).await;
            assert_eq!(ledger_account.live_value, 0);
        }

        #[cfg(feature = "full_tree")]
        #[tokio::test]
        async fn governance_actions_and_hook_toggles() {
            let fixture = IdentityFixture::new();
            let (mut context, setup) = setup_pool_test(&fixture).await;

            let configure_attempt = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::ConfigureHooks {
                    authority: context.payer.pubkey(),
                    pool_state: setup.pool_state,
                    hook_config: setup.hook_config,
                }
                .to_account_metas(None),
                data: crate::instruction::ConfigureHooks {
                    args: HookConfigArgs {
                        post_shield_program: hook_stub::ID,
                        post_unshield_program: Pubkey::default(),
                        required_accounts: vec![],
                        mode: HookAccountMode::Strict,
                    },
                }
                .data(),
            };

            let err = process_instruction(&mut context, configure_attempt, &[])
                .await
                .unwrap_err();
            assert_anchor_error(err, PoolError::HooksDisabled);

            let enable_hooks_ix = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::UpdateAuthority {
                    authority: context.payer.pubkey(),
                    pool_state: setup.pool_state,
                    nullifier_set: setup.nullifier_set,
                }
                .to_account_metas(None),
                data: crate::instruction::SetFeatures {
                    features: FEATURE_PRIVATE_TRANSFER_ENABLED | FEATURE_HOOKS_ENABLED,
                }
                .data(),
            };
            process_instruction(&mut context, enable_hooks_ix, &[])
                .await
                .expect("enable hooks");

            let required = Keypair::new();
            let create_required = system_instruction::create_account(
                &context.payer.pubkey(),
                &required.pubkey(),
                Rent::default().minimum_balance(0),
                0,
                &hook_stub::ID,
            );
            process_instruction(&mut context, create_required, &[&required])
                .await
                .expect("create hook acc");

            let configure_hooks_ix = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::ConfigureHooks {
                    authority: context.payer.pubkey(),
                    pool_state: setup.pool_state,
                    hook_config: setup.hook_config,
                }
                .to_account_metas(None),
                data: crate::instruction::ConfigureHooks {
                    args: HookConfigArgs {
                        post_shield_program: hook_stub::ID,
                        post_unshield_program: hook_stub::ID,
                        required_accounts: vec![required.pubkey()],
                        mode: HookAccountMode::Strict,
                    },
                }
                .data(),
            };

            let mut metas = configure_hooks_ix.accounts.clone();
            metas.push(AccountMeta::new_readonly(required.pubkey(), false));
            let configure_with_remaining = Instruction {
                program_id: configure_hooks_ix.program_id,
                accounts: metas,
                data: configure_hooks_ix.data.clone(),
            };
            process_instruction(&mut context, configure_with_remaining, &[&required])
                .await
                .expect("configure hooks");

            let mut tree: CommitmentTree = fetch_account(&mut context, setup.commitment_tree).await;
            let commitment = [11u8; 32];
            let amount_commit = [12u8; 32];
            let (new_root, _) = tree.append_note(commitment, amount_commit).unwrap();
            let (proof_bytes, public_inputs) =
                fixture.proof(&vec![Fr::from(0u64); IDENTITY_PUBLIC_INPUTS]);

            let mut accounts = crate::accounts::Shield {
                pool_state: setup.pool_state,
                hook_config: setup.hook_config,
                nullifier_set: setup.nullifier_set,
                commitment_tree: setup.commitment_tree,
                note_ledger: setup.note_ledger,
                vault_state: setup.vault_state,
                vault_token_account: setup.vault_token_account,
                depositor_token_account: setup.depositor_token_account,
                twin_mint: None,
                verifier_program: ptf_verifier_groth16::id(),
                verifying_key: setup.verifier_state,
                payer: context.payer.pubkey(),
                origin_mint: setup.origin_mint.pubkey(),
                vault_program: ptf_vault::id(),
                token_program: spl_token::id(),
            }
            .to_account_metas(None);
            accounts.push(AccountMeta::new_readonly(required.pubkey(), false));

            let shield_with_hook = Instruction {
                program_id: crate::id(),
                accounts,
                data: crate::instruction::Shield {
                    args: ShieldArgs {
                        new_root,
                        commitment,
                        amount_commit,
                        amount: 10,
                        proof: proof_bytes,
                        public_inputs,
                    },
                }
                .data(),
            };
            process_instruction(&mut context, shield_with_hook, &[])
                .await
                .expect("shield with hook");

            let pool_state_after: PoolState = fetch_account(&mut context, setup.pool_state).await;
            assert!(pool_state_after
                .features
                .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED)));
        }

        async fn setup_pool_test(fixture: &IdentityFixture) -> (ProgramTestContext, PoolSetup) {
            let mut program_test =
                ProgramTest::new("ptf_pool", crate::id(), processor!(ptf_pool::entry));
            program_test.add_program("ptf_vault", ptf_vault::id(), processor!(ptf_vault::entry));
            program_test.add_program(
                "ptf_verifier_groth16",
                ptf_verifier_groth16::id(),
                processor!(ptf_verifier_groth16::entry),
            );
            program_test.add_program(
                "ptf_factory",
                ptf_factory::id(),
                processor!(ptf_factory::entry),
            );
            program_test.add_program("hook_stub", hook_stub::ID, hook_stub::process_instruction);

            let mut context = program_test.start_with_context().await;
            context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

            let origin_mint = Keypair::new();
            let rent = Rent::default();
            let create_mint = system_instruction::create_account(
                &context.payer.pubkey(),
                &origin_mint.pubkey(),
                rent.minimum_balance(SplMint::LEN),
                SplMint::LEN as u64,
                &spl_token::id(),
            );
            let init_mint = spl_token::instruction::initialize_mint(
                &spl_token::id(),
                &origin_mint.pubkey(),
                &context.payer.pubkey(),
                None,
                6,
            )
            .unwrap();
            process_instruction(&mut context, create_mint, &[&origin_mint])
                .await
                .expect("create mint");
            process_instruction(&mut context, init_mint, &[])
                .await
                .expect("init mint");

            let ata_ix = ata_instruction::create_associated_token_account(
                &context.payer.pubkey(),
                &context.payer.pubkey(),
                &origin_mint.pubkey(),
                &spl_token::id(),
            );
            process_instruction(&mut context, ata_ix, &[])
                .await
                .expect("create ata");
            let depositor_token_account =
                get_associated_token_address(&context.payer.pubkey(), &origin_mint.pubkey());

            let mint_to = spl_token::instruction::mint_to(
                &spl_token::id(),
                &origin_mint.pubkey(),
                &depositor_token_account,
                &context.payer.pubkey(),
                &[],
                5_000_000,
            )
            .unwrap();
            process_instruction(&mut context, mint_to, &[])
                .await
                .expect("mint tokens");

            let circuit_tag = [5u8; 32];
            let version = 1u8;
            let (verifier_state, _) = Pubkey::find_program_address(
                &[seeds::VERIFIER, &circuit_tag, &[version]],
                &ptf_verifier_groth16::id(),
            );

            let init_verifier = Instruction {
                program_id: ptf_verifier_groth16::id(),
                accounts: ptf_verifier_groth16::accounts::InitializeVerifyingKey {
                    verifier_state,
                    authority: context.payer.pubkey(),
                    payer: context.payer.pubkey(),
                    system_program: system_program::id(),
                }
                .to_account_metas(None),
                data: ptf_verifier_groth16::instruction::InitializeVerifyingKey {
                    circuit_tag,
                    verifying_key_id: fixture.verifying_key_id,
                    hash: fixture.verifying_key_hash,
                    version,
                    verifying_key_data: fixture.verifying_key.clone(),
                }
                .data(),
            };
            process_instruction(&mut context, init_verifier, &[])
                .await
                .expect("init verifier");

            let (factory_state, _) = Pubkey::find_program_address(
                &[seeds::FACTORY, ptf_factory::id().as_ref()],
                &ptf_factory::id(),
            );
            let (mint_mapping, _) = Pubkey::find_program_address(
                &[seeds::MINT_MAPPING, origin_mint.pubkey().as_ref()],
                &ptf_factory::id(),
            );

            let init_factory = Instruction {
                program_id: ptf_factory::id(),
                accounts: ptf_factory::accounts::InitializeFactory {
                    factory_state,
                    authority: context.payer.pubkey(),
                    payer: context.payer.pubkey(),
                    system_program: system_program::id(),
                }
                .to_account_metas(None),
                data: ptf_factory::instruction::InitializeFactory {
                    authority: context.payer.pubkey(),
                    default_fee_bps: 5,
                    timelock_seconds: 0,
                }
                .data(),
            };
            process_instruction(&mut context, init_factory, &[])
                .await
                .expect("init factory");

            let register_mint = Instruction {
                program_id: ptf_factory::id(),
                accounts: ptf_factory::accounts::RegisterMint {
                    factory_state,
                    authority: context.payer.pubkey(),
                    mint_mapping,
                    origin_mint: origin_mint.pubkey(),
                    ptkn_mint: None,
                    payer: context.payer.pubkey(),
                    system_program: system_program::id(),
                }
                .to_account_metas(None),
                data: ptf_factory::instruction::RegisterMint {
                    decimals: 6,
                    enable_ptkn: false,
                    feature_flags: None,
                    fee_bps_override: None,
                }
                .data(),
            };
            process_instruction(&mut context, register_mint, &[])
                .await
                .expect("register mint");

            let (pool_state, _) = Pubkey::find_program_address(
                &[seeds::POOL, origin_mint.pubkey().as_ref()],
                &crate::id(),
            );
            let (vault_state, _) = Pubkey::find_program_address(
                &[seeds::VAULT, origin_mint.pubkey().as_ref()],
                &ptf_vault::id(),
            );

            let init_vault = Instruction {
                program_id: ptf_vault::id(),
                accounts: ptf_vault::accounts::InitializeVault {
                    vault_state,
                    origin_mint: origin_mint.pubkey(),
                    payer: context.payer.pubkey(),
                    system_program: system_program::id(),
                }
                .to_account_metas(None),
                data: ptf_vault::instruction::InitializeVault {
                    pool_authority: pool_state,
                }
                .data(),
            };
            process_instruction(&mut context, init_vault, &[])
                .await
                .expect("init vault");

            let vault_token = Keypair::new();
            let create_vault_token = system_instruction::create_account(
                &context.payer.pubkey(),
                &vault_token.pubkey(),
                rent.minimum_balance(SplAccount::LEN),
                SplAccount::LEN as u64,
                &spl_token::id(),
            );
            let init_vault_token = spl_token::instruction::initialize_account(
                &spl_token::id(),
                &vault_token.pubkey(),
                &origin_mint.pubkey(),
                &vault_state,
            )
            .unwrap();
            process_instruction(&mut context, create_vault_token, &[&vault_token])
                .await
                .expect("create vault token");
            process_instruction(&mut context, init_vault_token, &[])
                .await
                .expect("init vault token");

            let (nullifier_set, _) = Pubkey::find_program_address(
                &[seeds::NULLIFIERS, origin_mint.pubkey().as_ref()],
                &crate::id(),
            );
            let (note_ledger, _) = Pubkey::find_program_address(
                &[seeds::NOTES, origin_mint.pubkey().as_ref()],
                &crate::id(),
            );
            let (commitment_tree, _) = Pubkey::find_program_address(
                &[seeds::TREE, origin_mint.pubkey().as_ref()],
                &crate::id(),
            );
            let (hook_config, _) = Pubkey::find_program_address(
                &[seeds::HOOKS, origin_mint.pubkey().as_ref()],
                &crate::id(),
            );

            let init_pool = Instruction {
                program_id: crate::id(),
                accounts: crate::accounts::InitializePool {
                    authority: context.payer.pubkey(),
                    pool_state,
                    nullifier_set,
                    note_ledger,
                    commitment_tree,
                    hook_config,
                    vault_state,
                    origin_mint: origin_mint.pubkey(),
                    mint_mapping,
                    factory_state,
                    twin_mint: None,
                    verifier_program: ptf_verifier_groth16::id(),
                    verifying_key: verifier_state,
                    payer: context.payer.pubkey(),
                    system_program: system_program::id(),
                    token_program: spl_token::id(),
                }
                .to_account_metas(None),
                data: crate::instruction::InitializePool {
                    fee_bps: 5,
                    features: 0,
                }
                .data(),
            };
            process_instruction(&mut context, init_pool, &[])
                .await
                .expect("init pool");

            context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

            let setup = PoolSetup {
                pool_state,
                nullifier_set,
                note_ledger,
                commitment_tree,
                hook_config,
                vault_state,
                vault_token_account: vault_token.pubkey(),
                depositor_token_account,
                mint_mapping,
                factory_state,
                verifier_state,
                origin_mint,
                vault_token,
                circuit_tag,
                version,
            };

            (context, setup)
        }

        async fn process_instruction(
            context: &mut ProgramTestContext,
            instruction: Instruction,
            additional_signers: &[&Keypair],
        ) -> StdResult<(), BanksClientError> {
            let mut signers = vec![&context.payer];
            signers.extend_from_slice(additional_signers);

            let mut transaction =
                Transaction::new_with_payer(&[instruction], Some(&context.payer.pubkey()));
            transaction.sign(&signers, context.last_blockhash);
            let result = context.banks_client.process_transaction(transaction).await;
            if result.is_ok() {
                context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
            }
            result
        }

        async fn fetch_account<T: AccountDeserialize>(
            context: &mut ProgramTestContext,
            address: Pubkey,
        ) -> T {
            let account = context
                .banks_client
                .get_account(address)
                .await
                .unwrap()
                .unwrap();
            let mut data: &[u8] = &account.data;
            T::try_deserialize(&mut data).unwrap()
        }

        async fn get_token_balance(context: &mut ProgramTestContext, address: Pubkey) -> u64 {
            let account = context
                .banks_client
                .get_account(address)
                .await
                .unwrap()
                .unwrap();
            let token = SplAccount::unpack(&account.data).unwrap();
            token.amount
        }

        fn build_unshield_fields(
            pool_state: &PoolState,
            pool_state_key: Pubkey,
            old_root: [u8; 32],
            new_root: [u8; 32],
            nullifiers: &[[u8; 32]],
            output_commitments: &[[u8; 32]],
            output_amount_commitments: &[[u8; 32]],
            amount: u64,
            fee: u64,
            destination: Pubkey,
            mode: UnshieldMode,
        ) -> Vec<Fr> {
            let mut fields = Vec::new();
            fields.push(Fr::from_le_bytes_mod_order(&old_root));
            fields.push(Fr::from_le_bytes_mod_order(&new_root));
            for nullifier in nullifiers {
                fields.push(Fr::from_le_bytes_mod_order(nullifier));
            }
            for commitment in output_commitments {
                fields.push(Fr::from_le_bytes_mod_order(commitment));
            }
            for amount_commitment in output_amount_commitments {
                fields.push(Fr::from_le_bytes_mod_order(amount_commitment));
            }
            fields.push(Fr::from_le_bytes_mod_order(&u64_to_field_bytes(amount)));
            fields.push(Fr::from_le_bytes_mod_order(&u64_to_field_bytes(fee)));
            fields.push(Fr::from_le_bytes_mod_order(&destination.to_bytes()));
            fields.push(Fr::from_le_bytes_mod_order(&u8_to_field_bytes(mode as u8)));
            fields.push(Fr::from_le_bytes_mod_order(
                &pool_state.origin_mint.to_bytes(),
            ));
            fields.push(Fr::from_le_bytes_mod_order(&pool_state_key.to_bytes()));
            fields
        }

        fn assert_anchor_error(err: BanksClientError, expected: PoolError) {
            match err {
                BanksClientError::TransactionError(TransactionError::InstructionError(
                    _,
                    solana_sdk::instruction::InstructionError::Custom(code),
                )) => {
                    let expected_code: u32 = expected.into();
                    assert_eq!(code, expected_code);
                }
                other => panic!("unexpected error: {:?}", other),
            }
        }
    }
}
