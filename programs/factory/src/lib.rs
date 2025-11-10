use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use ptf_common::{seeds, FeatureFlags, MAX_BPS};
use solana_program::hash::hashv;

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
        ensure_direct_update_allowed(state)?;
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
        ensure_direct_update_allowed(state)?;

        apply_mint_update(mapping, &params, ctx.accounts.ptkn_mint.as_ref())?;

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

    pub fn queue_timelock_action(
        ctx: Context<QueueTimelockAction>,
        salt: [u8; 32],
        action: TimelockAction,
    ) -> Result<()> {
        let state = &ctx.accounts.factory_state;
        require!(!state.paused, FactoryError::Paused);

        let clock = Clock::get()?;
        let execute_after = clock
            .unix_timestamp
            .checked_add(state.timelock_seconds)
            .ok_or_else(|| error!(FactoryError::TimelockOverflow))?;

        let action_bytes = action
            .try_to_vec()
            .map_err(|_| error!(FactoryError::SerializationError))?;
        let expected_hash = hashv(&[
            state.key().as_ref(),
            &action_bytes,
            &execute_after.to_le_bytes(),
        ]);

        if let TimelockAction::UpdateMint { origin_mint, .. } = &action {
            let mapping = ctx
                .accounts
                .mint_mapping
                .as_ref()
                .ok_or(FactoryError::TimelockMissingMapping)?;
            require_keys_eq!(
                mapping.origin_mint,
                *origin_mint,
                FactoryError::OriginMintMismatch
            );
        }

        let entry = &mut ctx.accounts.timelock_entry;
        entry.factory = state.key();
        entry.salt = salt;
        entry.action_hash = expected_hash.to_bytes();
        entry.queued_at = clock.unix_timestamp;
        entry.execute_after = execute_after;
        entry.executed = false;
        entry.action = action;
        entry.bump = ctx.bumps.timelock_entry;

        emit!(TimelockQueued {
            factory: state.key(),
            action_hash: entry.action_hash,
            queued_at: clock.unix_timestamp,
            execute_after,
        });
        Ok(())
    }

    pub fn execute_timelock_action(ctx: Context<ExecuteTimelockAction>) -> Result<()> {
        let state = &mut ctx.accounts.factory_state;
        let entry = &mut ctx.accounts.timelock_entry;
        require!(!entry.executed, FactoryError::TimelockConsumed);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= entry.execute_after,
            FactoryError::TimelockNotReady
        );

        match &entry.action {
            TimelockAction::SetDefaultFeatures { features } => {
                state.default_features = FeatureFlags::from(*features);
                state.last_updated_slot = clock.slot;
                emit!(DefaultFeaturesUpdated {
                    authority: state.authority,
                    features: *features,
                });
            }
            TimelockAction::UpdateMint {
                origin_mint,
                params,
            } => {
                let mapping = ctx
                    .accounts
                    .mint_mapping
                    .as_mut()
                    .ok_or(FactoryError::TimelockMissingMapping)?;
                require_keys_eq!(
                    mapping.origin_mint,
                    *origin_mint,
                    FactoryError::OriginMintMismatch
                );
                apply_mint_update(mapping, params, ctx.accounts.ptkn_mint.as_ref())?;
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
            }
            TimelockAction::PauseFactory => {
                state.paused = true;
                emit!(FactoryPaused {
                    authority: state.authority,
                });
            }
            TimelockAction::UnpauseFactory => {
                state.paused = false;
                emit!(FactoryUnpaused {
                    authority: state.authority,
                });
            }
        }

        state.last_updated_slot = clock.slot;
        entry.executed = true;

        emit!(TimelockExecuted {
            factory: state.key(),
            action_hash: entry.action_hash,
            executed_at: clock.unix_timestamp,
            executor: ctx.accounts.executor.key(),
        });
        Ok(())
    }

    pub fn cancel_timelock_action(ctx: Context<CancelTimelockAction>) -> Result<()> {
        let entry = &mut ctx.accounts.timelock_entry;
        require!(!entry.executed, FactoryError::TimelockConsumed);
        entry.executed = true;
        let clock = Clock::get()?;

        emit!(TimelockCanceled {
            factory: ctx.accounts.factory_state.key(),
            action_hash: entry.action_hash,
            canceled_at: clock.unix_timestamp,
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

#[derive(Accounts)]
#[instruction(salt: [u8; 32], action: TimelockAction)]
pub struct QueueTimelockAction<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::TIMELOCK, factory_state.key().as_ref(), salt.as_ref()],
        bump,
        space = TimelockEntry::SPACE,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub mint_mapping: Option<Account<'info, MintMapping>>,
}

#[derive(Accounts)]
pub struct ExecuteTimelockAction<'info> {
    #[account(mut)]
    pub factory_state: Account<'info, FactoryState>,
    #[account(
        mut,
        seeds = [
            seeds::TIMELOCK,
            factory_state.key().as_ref(),
            timelock_entry.salt.as_ref()
        ],
        bump = timelock_entry.bump,
        constraint = timelock_entry.factory == factory_state.key() @ FactoryError::TimelockInvalidFactory,
        close = executor,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub mint_mapping: Option<Account<'info, MintMapping>>,
    #[account(mut)]
    pub ptkn_mint: Option<Account<'info, Mint>>,
    #[account(mut)]
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelTimelockAction<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [
            seeds::TIMELOCK,
            factory_state.key().as_ref(),
            timelock_entry.salt.as_ref()
        ],
        bump = timelock_entry.bump,
        constraint = timelock_entry.factory == factory_state.key() @ FactoryError::TimelockInvalidFactory,
        close = authority,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
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

#[account]
pub struct TimelockEntry {
    pub factory: Pubkey,
    pub salt: [u8; 32],
    pub action_hash: [u8; 32],
    pub queued_at: i64,
    pub execute_after: i64,
    pub executed: bool,
    pub action: TimelockAction,
    pub bump: u8,
}

impl TimelockEntry {
    pub const MAX_ACTION_SIZE: usize = 128;
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + Self::MAX_ACTION_SIZE;
}

fn ensure_direct_update_allowed(state: &FactoryState) -> Result<()> {
    if state.timelock_seconds > 0 {
        return Err(error!(FactoryError::TimelockOnlyQueue));
    }
    Ok(())
}

fn apply_mint_update<'info>(
    mapping: &mut MintMapping,
    params: &UpdateMintParams,
    ptkn_mint: Option<&Account<'info, Mint>>,
) -> Result<()> {
    if let Some(fee) = params.fee_bps_override {
        require!(fee <= MAX_BPS, FactoryError::InvalidFeeBps);
        mapping.fee_bps_override = fee;
        mapping.has_fee_override = true;
    }

    if let Some(features) = params.features {
        mapping.features = FeatureFlags::from(features);
    }

    if let Some(enable_ptkn) = params.enable_ptkn {
        if enable_ptkn {
            if !mapping.has_ptkn {
                let ptkn_mint = ptkn_mint.ok_or(FactoryError::PtknMintMissing)?;
                require!(
                    ptkn_mint.decimals == mapping.decimals,
                    FactoryError::InvalidDecimals
                );
                mapping.has_ptkn = true;
                mapping.ptkn_mint = ptkn_mint.key();
            } else if let Some(ptkn_mint) = ptkn_mint {
                require_keys_eq!(
                    ptkn_mint.key(),
                    mapping.ptkn_mint,
                    FactoryError::PtknMintMismatch
                );
                require!(
                    ptkn_mint.decimals == mapping.decimals,
                    FactoryError::InvalidDecimals
                );
            }
        } else {
            mapping.has_ptkn = false;
            mapping.ptkn_mint = Pubkey::default();
        }
    }

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct UpdateMintParams {
    pub enable_ptkn: Option<bool>,
    pub features: Option<u8>,
    pub fee_bps_override: Option<u16>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    SetDefaultFeatures {
        features: u8,
    },
    UpdateMint {
        origin_mint: Pubkey,
        params: UpdateMintParams,
    },
    PauseFactory,
    UnpauseFactory,
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

#[event]
pub struct TimelockQueued {
    pub factory: Pubkey,
    pub action_hash: [u8; 32],
    pub queued_at: i64,
    pub execute_after: i64,
}

#[event]
pub struct TimelockExecuted {
    pub factory: Pubkey,
    pub action_hash: [u8; 32],
    pub executed_at: i64,
    pub executor: Pubkey,
}

#[event]
pub struct TimelockCanceled {
    pub factory: Pubkey,
    pub action_hash: [u8; 32],
    pub canceled_at: i64,
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
    #[msg("privacy twin mint mismatch")]
    PtknMintMismatch,
    #[msg("timelock window overflow")]
    TimelockOverflow,
    #[msg("timelock action already processed")]
    TimelockConsumed,
    #[msg("timelock action not ready for execution")]
    TimelockNotReady,
    #[msg("timelock action requires mint mapping")]
    TimelockMissingMapping,
    #[msg("timelock entry does not belong to this factory")]
    TimelockInvalidFactory,
    #[msg("direct updates are disabled when timelock is configured")]
    TimelockOnlyQueue,
    #[msg("failed to serialize timelock action")]
    SerializationError,
    #[msg("origin mint mismatch")]
    OriginMintMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::{
        program_option::COption, system_program, sysvar::rent::Rent,
    };
    use anchor_lang::{prelude::*, AccountDeserialize, InstructionData, ToAccountMetas};
    use ptf_common::{seeds, FEATURE_HOOKS_ENABLED};
    use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
    use solana_sdk::{
        instruction::Instruction,
        instruction::InstructionError,
        signature::Keypair,
        signer::Signer,
        transaction::{Transaction, TransactionError},
    };
    use spl_token::state::Mint as SplMint;

    const DEFAULT_FEE_BPS: u16 = 5;
    const TIMELOCK_SECS: i64 = 5;

    #[tokio::test]
    async fn timelock_blocks_direct_update() {
        let authority = Keypair::new();
        let mut program_test =
            ProgramTest::new("ptf_factory", crate::id(), processor!(ptf_factory::entry));

        let mut context = program_test.start_with_context().await;
        context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

        initialize_factory(&mut context, &authority, DEFAULT_FEE_BPS, TIMELOCK_SECS)
            .await
            .unwrap();

        let (factory_state, _) = factory_state_pda();
        let ix = Instruction {
            program_id: crate::id(),
            accounts: crate::accounts::SetDefaultFeatures {
                factory_state,
                authority: authority.pubkey(),
            }
            .to_account_metas(None),
            data: crate::instruction::SetDefaultFeatures {
                default_features: FEATURE_HOOKS_ENABLED,
            }
            .data(),
        };

        let err = process_instruction(&mut context, ix, &[&authority])
            .await
            .unwrap_err();
        assert_anchor_error(err, FactoryError::TimelockOnlyQueue);
    }

    #[tokio::test]
    async fn timelock_queue_and_execute_mint_update() {
        let authority = Keypair::new();
        let origin_mint = Keypair::new();

        let mut program_test =
            ProgramTest::new("ptf_factory", crate::id(), processor!(ptf_factory::entry));

        let rent = Rent::default();
        let mut mint_account = solana_sdk::account::Account::new(
            rent.minimum_balance(SplMint::LEN),
            SplMint::LEN,
            &spl_token::id(),
        );
        let mut mint_state = SplMint::default();
        mint_state.decimals = 6;
        mint_state.mint_authority = COption::Some(authority.pubkey());
        mint_state.pack_into_slice(&mut mint_account.data_mut());
        program_test.add_account(origin_mint.pubkey(), mint_account);

        let mut context = program_test.start_with_context().await;
        context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

        initialize_factory(&mut context, &authority, DEFAULT_FEE_BPS, TIMELOCK_SECS)
            .await
            .unwrap();

        register_mint(&mut context, &authority, &origin_mint, 6)
            .await
            .unwrap();

        let salt = [7u8; 32];
        let (factory_state, _) = factory_state_pda();
        let (mint_mapping, _) = mint_mapping_pda(origin_mint.pubkey());
        let (timelock_entry, _) = timelock_entry_pda(factory_state, &salt);

        let action = TimelockAction::UpdateMint {
            origin_mint: origin_mint.pubkey(),
            params: UpdateMintParams {
                enable_ptkn: None,
                features: Some(FEATURE_HOOKS_ENABLED),
                fee_bps_override: None,
            },
        };

        let queue_ix = Instruction {
            program_id: crate::id(),
            accounts: crate::accounts::QueueTimelockAction {
                factory_state,
                authority: authority.pubkey(),
                timelock_entry,
                payer: context.payer.pubkey(),
                system_program: system_program::id(),
                mint_mapping: Some(mint_mapping),
            }
            .to_account_metas(None),
            data: crate::instruction::QueueTimelockAction {
                salt,
                action: action.clone(),
            }
            .data(),
        };
        process_instruction(&mut context, queue_ix, &[&authority])
            .await
            .unwrap();

        let execute_ix = Instruction {
            program_id: crate::id(),
            accounts: crate::accounts::ExecuteTimelockAction {
                factory_state,
                timelock_entry,
                mint_mapping: Some(mint_mapping),
                ptkn_mint: None,
                executor: authority.pubkey(),
            }
            .to_account_metas(None),
            data: crate::instruction::ExecuteTimelockAction {}.data(),
        };

        let err = process_instruction(&mut context, execute_ix.clone(), &[&authority])
            .await
            .unwrap_err();
        assert_anchor_error(err, FactoryError::TimelockNotReady);

        advance_clock(&mut context, 10).await;

        process_instruction(&mut context, execute_ix, &[&authority])
            .await
            .unwrap();

        let mut account_data = context
            .banks_client
            .get_account(mint_mapping)
            .await
            .unwrap()
            .unwrap()
            .data;
        let mapping = MintMapping::try_deserialize(&mut account_data.as_slice()).unwrap();
        assert!(mapping
            .features
            .contains(FeatureFlags::from_bits(FEATURE_HOOKS_ENABLED)));
    }

    async fn initialize_factory(
        context: &mut ProgramTestContext,
        authority: &Keypair,
        default_fee_bps: u16,
        timelock_seconds: i64,
    ) -> Result<(), BanksClientError> {
        let (factory_state, _) = factory_state_pda();
        let ix = Instruction {
            program_id: crate::id(),
            accounts: crate::accounts::InitializeFactory {
                factory_state,
                authority: authority.pubkey(),
                payer: context.payer.pubkey(),
                system_program: system_program::id(),
            }
            .to_account_metas(None),
            data: crate::instruction::InitializeFactory {
                authority: authority.pubkey(),
                default_fee_bps,
                timelock_seconds,
            }
            .data(),
        };
        process_instruction(context, ix, &[authority]).await
    }

    async fn register_mint(
        context: &mut ProgramTestContext,
        authority: &Keypair,
        origin_mint: &Keypair,
        decimals: u8,
    ) -> Result<(), BanksClientError> {
        let (factory_state, _) = factory_state_pda();
        let (mint_mapping, _) = mint_mapping_pda(origin_mint.pubkey());
        let ix = Instruction {
            program_id: crate::id(),
            accounts: crate::accounts::RegisterMint {
                factory_state,
                authority: authority.pubkey(),
                mint_mapping,
                origin_mint: origin_mint.pubkey(),
                ptkn_mint: None,
                payer: context.payer.pubkey(),
                system_program: system_program::id(),
            }
            .to_account_metas(None),
            data: crate::instruction::RegisterMint {
                decimals,
                enable_ptkn: false,
                feature_flags: None,
                fee_bps_override: None,
            }
            .data(),
        };
        process_instruction(context, ix, &[authority]).await
    }

    async fn process_instruction(
        context: &mut ProgramTestContext,
        instruction: Instruction,
        additional_signers: &[&Keypair],
    ) -> Result<(), BanksClientError> {
        let mut tx = Transaction::new_with_payer(&[instruction], Some(&context.payer.pubkey()));
        let mut signers = vec![&context.payer];
        signers.extend_from_slice(additional_signers);
        tx.sign(&signers, context.last_blockhash);
        let result = context.banks_client.process_transaction(tx).await;
        if result.is_ok() {
            context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
        }
        result
    }

    async fn advance_clock(context: &mut ProgramTestContext, slots: u64) {
        let current_slot = context.slot();
        context.warp_to_slot(current_slot + slots).unwrap();
        context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    }

    fn factory_state_pda() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[seeds::FACTORY, crate::id().as_ref()], &crate::id())
    }

    fn mint_mapping_pda(origin_mint: Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[seeds::MINT_MAPPING, origin_mint.as_ref()], &crate::id())
    }

    fn timelock_entry_pda(factory_state: Pubkey, salt: &[u8; 32]) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::TIMELOCK, factory_state.as_ref(), salt.as_ref()],
            &crate::id(),
        )
    }

    fn assert_anchor_error(err: BanksClientError, expected: FactoryError) {
        match err {
            BanksClientError::TransactionError(TransactionError::InstructionError(
                _,
                InstructionError::Custom(code),
            )) => {
                let expected_code: u32 = expected.into();
                assert_eq!(code, expected_code);
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }
}
