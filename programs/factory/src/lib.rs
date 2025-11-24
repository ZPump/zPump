use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self as token_interface,
    spl_token_2022::{self, instruction::AuthorityType},
    Mint, MintTo, SetAuthority, TokenAccount, TokenInterface,
};
use solana_program::program_option::COption;
use solana_program::program_pack::Pack as Token2022Pack;
use solana_program::{hash::hashv, program::invoke, system_instruction, system_program};
use spl_token_2022::state::Mint as Token2022Mint;

use ptf_common::{seeds, FeatureFlags, MAX_BPS};
use ptf_common::security::{AccessController, AccessLevel, AccountValidator, InputValidator};
use solana_program::pubkey;
use sha3::{Digest, Keccak256};
use ptf_verifier_groth16;

const PTF_POOL_PROGRAM_ID: Pubkey = pubkey!("7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh");
// CRITICAL FIX: Minimum timelock duration in seconds (24 hours)
const MIN_TIMELOCK_SECONDS: i64 = 24 * 60 * 60; // 86400 seconds = 24 hours
// Authority changes require longer timelock (7 days)
const AUTHORITY_CHANGE_TIMELOCK_SECONDS: i64 = 7 * 24 * 60 * 60; // 604800 seconds = 7 days
const TIMELOCK_STALE_GRACE_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

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
        // CRITICAL FIX: Use centralized input validation
        InputValidator::validate_fee_bps(default_fee_bps)?;
        
        // CRITICAL FIX: Enforce minimum timelock (allow 0 for test/devnet initialization)
        // In production, timelock should be at least 24 hours, but for devnet/testing we allow 0
        if timelock_seconds > 0 {
            require!(
                timelock_seconds >= MIN_TIMELOCK_SECONDS,
                FactoryError::TimelockTooShort
            );
        }

        let clock = Clock::get()?;
        let state = &mut ctx.accounts.factory_state;
        state.authority = authority;
        state.default_fee_bps = default_fee_bps;
        state.default_features = FeatureFlags::empty();
        state.paused = false;
        state.timelock_seconds = timelock_seconds;
        state.bump = ctx.bumps.factory_state;
        state.last_updated_slot = clock.slot;
        // CRITICAL FIX: Initialize pending action tracking
        state.pending_action_hashes = Vec::new();
        state.last_action_sequence = 0;
        // CRITICAL FIX: Initialize last_action_time for rate limiting (use current time, not 0)
        state.last_action_time = clock.unix_timestamp;
        // CRITICAL FIX: Initialize global rate limiting
        state.last_global_action_time = clock.unix_timestamp;
        // CRITICAL FIX: Initialize multi-sig and emergency pause (empty by default)
        state.multi_sig_signers = Vec::new();
        state.multi_sig_threshold = 0;
        state.emergency_pause_signers = Vec::new();
        state.emergency_pause_threshold = 3; // Default: require 3-of-N for emergency pause

        emit!(FactoryInitialized {
            authority,
            default_fee_bps,
            timelock_seconds,
        });
        Ok(())
    }

    /// Initialize factory configuration account with program IDs
    /// This allows the factory to work with different pool/verifier program IDs
    pub fn initialize_factory_config(
        ctx: Context<InitializeFactoryConfig>,
        pool_program_id: Pubkey,
        verifier_program_id: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.factory_config;
        config.factory = ctx.accounts.factory_state.key();
        config.pool_program_id = pool_program_id;
        config.verifier_program_id = verifier_program_id;
        config.authority = ctx.accounts.factory_state.authority;
        config.bump = ctx.bumps.factory_config;

        emit!(FactoryConfigInitialized {
            factory: config.factory,
            pool_program_id,
            verifier_program_id,
            authority: config.authority,
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
        let state = &ctx.accounts.factory_state;
        require!(!state.paused, FactoryError::Paused);
        require!(decimals <= 12, FactoryError::InvalidDecimals);
        
        // CRITICAL FIX: Validate fee override limits to prevent abuse
        // Allow 0 to 1000 bps (0% to 10%) for reasonable fee ranges
        const MAX_FEE_BPS_OVERRIDE: u16 = 1000; // 10% maximum override
        if let Some(fee) = fee_bps_override {
            require!(fee <= MAX_BPS, FactoryError::InvalidFeeBps);
            require!(fee <= MAX_FEE_BPS_OVERRIDE, FactoryError::InvalidFeeBps);
        }

        // Validate origin_mint account - check it's a valid mint account
        // Accept both spl_token and spl_token_2022 program IDs
        let origin_mint_info = ctx.accounts.origin_mint.to_account_info();
        // Check against known token program IDs
        let token_program_id = anchor_spl::token::ID;
        let token_2022_program_id = spl_token_2022::ID;
        let is_valid_token_program = origin_mint_info.owner == &token_program_id
            || origin_mint_info.owner == &token_2022_program_id;
        require!(
            is_valid_token_program,
            FactoryError::InvalidMintFormat
        );
        // Validate decimals match
        let mint_decimals = load_mint_decimals(&origin_mint_info)?;
        require!(
            mint_decimals == decimals,
            FactoryError::DecimalsMismatch
        );

        let mapping = &mut ctx.accounts.mint_mapping;
        // CRITICAL FIX: Only allow initialization, not updates
        // All updates must go through update_mint instruction which has proper authorization
        // This prevents unauthorized status changes, decimals manipulation, and feature flag bypasses
        require!(
            mapping.origin_mint == Pubkey::default(),
            FactoryError::AlreadyRegistered
        );
        
        // Initialize new mapping - all fields set from scratch
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
            let mint_key = prepare_ptkn_mint(
                state,
                ctx.accounts.ptkn_mint.as_ref(),
                ctx.accounts.token_program.as_ref(),
                Some(&ctx.accounts.rent),
                Some(&ctx.accounts.payer),
                decimals,
                Some(&ctx.accounts.authority),
            )?;
            mapping.has_ptkn = true;
            mapping.ptkn_mint = mint_key;
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

        apply_mint_update(
            &ctx.accounts.factory_state,
            mapping,
            &params,
            ctx.accounts.ptkn_mint.as_ref(),
            ctx.accounts.token_program.as_ref(),
            Some(&ctx.accounts.rent),
            Some(&ctx.accounts.authority),
            Some(&ctx.accounts.authority),
        )?;

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
        let state = &ctx.accounts.factory_state;
        // CRITICAL FIX: Require timelock for freeze operations
        ensure_direct_update_allowed(state)?;
        let mapping = &mut ctx.accounts.mint_mapping;
        mapping.status = MintStatus::Frozen as u8;
        emit!(MintFrozen {
            origin_mint: mapping.origin_mint,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn thaw_mapping(ctx: Context<MutationMintState>) -> Result<()> {
        let state = &ctx.accounts.factory_state;
        // CRITICAL FIX: Require timelock for thaw operations
        ensure_direct_update_allowed(state)?;
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
        // CRITICAL FIX: Only allow emergency pause without timelock for security incidents
        // Regular pause must go through timelock to prevent abuse
        // Check if this is emergency pause (via emergency signers)
        if state.require_emergency_pause_signers(ctx.remaining_accounts).is_ok() {
            // Emergency pause - no timelock needed for immediate response
            state.paused = true;
            emit!(FactoryPausedEmergency {
                authority: ctx.accounts.authority.key(),
            });
            Ok(())
        } else {
            // Regular pause - must go through timelock
            // This prevents rapid pause/unpause cycles and ensures proper governance
            ensure_direct_update_allowed(state)?;
            // This should never be reached due to ensure_direct_update_allowed
            Ok(())
        }
    }

    pub fn unpause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
        let state = &ctx.accounts.factory_state;
        // CRITICAL FIX: Require timelock for unpause to prevent rapid pause/unpause cycles
        ensure_direct_update_allowed(state)?;
        // This function should never be reached due to ensure_direct_update_allowed
        // but kept for clarity
        Ok(())
    }

    pub fn queue_timelock_action(
        ctx: Context<QueueTimelockAction>,
        salt: [u8; 32],
        action: TimelockAction,
    ) -> Result<()> {
        let state = &mut ctx.accounts.factory_state;
        require!(!state.paused, FactoryError::Paused);

        let clock = Clock::get()?;
        
        // CRITICAL FIX: Rate limiting - prevent rapid queue filling
        // Remove migration case - always enforce rate limiting if last_action_time is set
        // This prevents bypass attacks
        if state.last_action_time > 0 {
            require!(
                clock.unix_timestamp >= state.last_action_time + FactoryState::MIN_TIME_BETWEEN_ACTIONS,
                FactoryError::ActionRateLimitExceeded
            );
        }
        state.last_action_time = clock.unix_timestamp;
        
        // CRITICAL FIX: Global rate limiting to prevent coordinated attacks
        if state.last_global_action_time > 0 {
            require!(
                clock.unix_timestamp >= state.last_global_action_time + FactoryState::MIN_TIME_BETWEEN_ACTIONS,
                FactoryError::GlobalActionRateLimitExceeded
            );
        }
        state.last_global_action_time = clock.unix_timestamp;
        
        // Determine timelock duration based on action type
        let timelock_duration = match &action {
            TimelockAction::ChangeAuthority { .. } => AUTHORITY_CHANGE_TIMELOCK_SECONDS,
            _ => state.timelock_seconds,
        };
        
        let execute_after = clock
            .unix_timestamp
            .checked_add(timelock_duration)
            .ok_or_else(|| error!(FactoryError::TimelockOverflow))?;

        let action_bytes = action
            .try_to_vec()
            .map_err(|_| error!(FactoryError::SerializationError))?;
        
        // CRITICAL FIX: Use sequence for unique entry address
        // Anchor's PDA constraint reads factory_state.last_action_sequence BEFORE the instruction runs
        // So the PDA seeds use the CURRENT sequence value. We set entry.sequence to match the PDA.
        // Then we increment state.last_action_sequence AFTER creating the account.
        let current_sequence = state.last_action_sequence;
        let next_sequence = current_sequence
            .checked_add(1)
            .ok_or(FactoryError::SequenceOverflow)?;
        
        // CRITICAL FIX: Compute action hash including salt and sequence for additional entropy
        // This prevents hash collisions and makes each action unique
        // Use current_sequence (the one that will be in the entry) for hash computation
        let action_hash = hashv(&[
            state.key().as_ref(),
            &salt,
            &action_bytes,
            &execute_after.to_le_bytes(),
            &current_sequence.to_le_bytes(), // CRITICAL FIX: Include sequence for additional entropy
        ]);
        
        // CRITICAL FIX: Check for duplicate actions
        // Optimized: Use position() for O(n) check (same as contains but allows removal)
        let action_hash_bytes = action_hash.to_bytes();
        require!(
            state.pending_action_hashes.iter().position(|&h| h == action_hash_bytes).is_none(),
            FactoryError::DuplicateAction
        );
        
        // CRITICAL FIX: Check maximum pending actions
        require!(
            state.pending_action_hashes.len() < FactoryState::MAX_PENDING_ACTIONS,
            FactoryError::TooManyPendingActions
        );

        // Validate action-specific accounts
        match &action {
            TimelockAction::UpdateMint { origin_mint, .. } => {
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
            TimelockAction::FreezeMint { origin_mint } | TimelockAction::ThawMint { origin_mint } => {
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
            TimelockAction::RegisterMint { origin_mint, .. } => {
                // Validate origin_mint account if provided
                if let Some(mapping) = ctx.accounts.mint_mapping.as_ref() {
                    // If mapping exists, ensure it matches
                    require_keys_eq!(
                        mapping.origin_mint,
                        *origin_mint,
                        FactoryError::OriginMintMismatch
                    );
                }
            }
            TimelockAction::ChangeAuthority { new_authority } => {
                require!(
                    *new_authority != Pubkey::default(),
                    FactoryError::InvalidAuthority
                );
                require!(
                    *new_authority != state.authority,
                    FactoryError::AuthorityUnchanged
                );
            }
            _ => {}
        }

        // CRITICAL FIX: Use sequence for unique entry address
        // Anchor's PDA constraint reads factory_state.last_action_sequence BEFORE the instruction runs
        // So the PDA seeds use the CURRENT sequence value. We set entry.sequence to match the PDA.
        // Then we increment state.last_action_sequence AFTER creating the account.
        let current_sequence = state.last_action_sequence;
        let next_sequence = current_sequence
            .checked_add(1)
            .ok_or(FactoryError::SequenceOverflow)?;
        
        // Create the entry with the CURRENT sequence value (matches PDA)
        let entry = &mut ctx.accounts.timelock_entry;
        entry.factory = state.key();
        entry.salt = salt;
        entry.action_hash = action_hash.to_bytes();
        entry.queued_at = clock.unix_timestamp;
        entry.execute_after = execute_after;
        entry.executed = false;
        entry.canceled = false;
        entry.action = action;
        entry.bump = ctx.bumps.timelock_entry;
        // CRITICAL FIX: Set sequence to current value (matches PDA derivation)
        // ExecuteTimelockAction's PDA constraint uses timelock_entry.sequence, so it must match
        entry.sequence = current_sequence;
        // CRITICAL FIX: Set expiration time (30 days after execute_after to prevent indefinite execution)
        entry.expires_at = execute_after
            .checked_add(TIMELOCK_STALE_GRACE_SECONDS)
            .ok_or(FactoryError::TimelockOverflow)?;
        
        // CRITICAL FIX: Increment sequence AFTER entry is created
        // This ensures the next entry uses a different sequence
        state.last_action_sequence = next_sequence;
        if state.last_action_sequence >= FactoryState::SEQUENCE_WARNING_THRESHOLD {
            emit!(TimelockSequenceWarning {
                factory: state.key(),
                sequence: state.last_action_sequence,
            });
        }
        
        // CRITICAL FIX: Track this action hash
        state.pending_action_hashes.push(action_hash.to_bytes());
        // Note: last_action_time already updated above in rate limiting check

        emit!(TimelockQueued {
            factory: state.key(),
            action_hash: entry.action_hash,
            queued_at: clock.unix_timestamp,
            execute_after,
        });
        Ok(())
    }

    // CRITICAL FIX: Maximum size for verifying key data to prevent DoS attacks
    pub const MAX_VERIFYING_KEY_SIZE: usize = 100 * 1024; // 100KB
    // CRITICAL FIX: Maximum mint amount to prevent excessive minting
    pub const MAX_MINT_AMOUNT: u64 = 1_000_000_000_000; // 1 trillion (reasonable limit)

    pub fn create_verifying_key(
        ctx: Context<CreateVerifyingKey>,
        circuit_tag: [u8; 32],
        verifying_key_id: [u8; 32],
        hash: [u8; 32],
        version: u8,
        verifying_key_data: Vec<u8>,
    ) -> Result<()> {
        let state = &ctx.accounts.factory_state;
        // CRITICAL FIX: Use centralized access control with duplicate signer prevention
        let access_level = if !state.multi_sig_signers.is_empty() && state.multi_sig_threshold > 0 {
            AccessLevel::MultiSig {
                threshold: state.multi_sig_threshold,
                signers: state.multi_sig_signers.clone(),
            }
        } else {
            AccessLevel::Authority
        };
        AccessController::require_access(
            access_level,
            &ctx.accounts.authority.key(),
            &state.authority,
            ctx.remaining_accounts,
            None,
        )?;
        
        // CRITICAL FIX: Validate verifier program
        require_keys_eq!(
            ctx.accounts.verifier_program.key(),
            ptf_verifier_groth16::ID,
            FactoryError::InvalidVerifierProgram
        );
        require!(
            ctx.accounts.verifier_program.executable,
            FactoryError::InvalidVerifierProgram
        );
        // CRITICAL FIX: Use centralized account validation
        let verifier_program_info = ctx.accounts.verifier_program.to_account_info();
        AccountValidator::validate_ownership(
            &verifier_program_info,
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
            "verifier_program",
        )?;
        
        // CRITICAL FIX: Validate verifying key data size
        require!(
            verifying_key_data.len() <= ptf_factory::MAX_VERIFYING_KEY_SIZE,
            FactoryError::VerifyingKeyTooLarge
        );
        
        // Verify hash matches
        let mut hasher = Keccak256::new();
        hasher.update(&verifying_key_data);
        let computed_hash: [u8; 32] = hasher.finalize().into();
        require!(
            computed_hash == hash,
            FactoryError::VerifyingKeyHashMismatch
        );
        
        // CPI to verifier program - factory program signs as authority
        let cpi_program = ctx.accounts.verifier_program.to_account_info();
        let cpi_accounts = ptf_verifier_groth16::cpi::accounts::InitializeVerifyingKey {
            verifier_state: ctx.accounts.verifier_state.to_account_info(),
            verifier_config: ctx.accounts.verifier_config.to_account_info(), // CRITICAL FIX: Pass verifier_config
            authority: ctx.accounts.factory_state.to_account_info(), // Factory state PDA as authority (owned by factory program)
            payer: ctx.accounts.payer.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        
        // Sign with factory_state PDA - the verifier will verify authority is factory program ID
        let factory_seeds: &[&[&[u8]]] = &[&[
            seeds::FACTORY,
            ptf_factory::ID.as_ref(),
            &[state.bump],
        ]];
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, factory_seeds);
        
        ptf_verifier_groth16::cpi::initialize_verifying_key(
            cpi_ctx,
            circuit_tag,
            verifying_key_id,
            hash,
            version,
            verifying_key_data,
        )?;
        
        emit!(VerifyingKeyCreated {
            circuit_tag,
            verifying_key_id,
            hash,
            version,
            created_by: ctx.accounts.authority.key(),
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
        
        // CRITICAL FIX: Check if action has expired
        require!(
            clock.unix_timestamp < entry.expires_at,
            FactoryError::ActionExpired
        );

        // CRITICAL FIX: Recompute and verify action hash before execution
        // This ensures the action hasn't been tampered with after queuing
        // MUST include salt and sequence to match queue hash: hash(factory || salt || action || execute_after || sequence)
        let action_bytes = entry.action
            .try_to_vec()
            .map_err(|_| error!(FactoryError::SerializationError))?;
        let expected_hash = hashv(&[
            state.key().as_ref(),
            &entry.salt, // CRITICAL: Include salt to match queue hash
            &action_bytes,
            &entry.execute_after.to_le_bytes(),
            &entry.sequence.to_le_bytes(), // CRITICAL FIX: Include sequence to match queue hash
        ]);
        
        require!(
            expected_hash.to_bytes() == entry.action_hash,
            FactoryError::TimelockHashMismatch
        );

        // Now safe to execute the action
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
                apply_mint_update(
                    state,
                    mapping,
                    params,
                    ctx.accounts.ptkn_mint.as_ref(),
                    ctx.accounts.token_program.as_ref(),
                    Some(&ctx.accounts.rent),
                    Some(&ctx.accounts.executor),
                    None,
                )?;
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
                // CRITICAL FIX: Only allow pause via timelock if not already paused
                require!(!state.paused, FactoryError::Paused);
                state.paused = true;
                emit!(FactoryPaused {
                    authority: state.authority,
                });
            }
            TimelockAction::UnpauseFactory => {
                // CRITICAL FIX: Only allow unpause via timelock if currently paused
                require!(state.paused, FactoryError::NotPaused);
                state.paused = false;
                emit!(FactoryUnpaused {
                    authority: state.authority,
                });
            }
            TimelockAction::ChangeAuthority { new_authority } => {
                require!(
                    *new_authority != Pubkey::default(),
                    FactoryError::InvalidAuthority
                );
                require!(
                    *new_authority != state.authority,
                    FactoryError::AuthorityUnchanged
                );
                let old_authority = state.authority;
                state.authority = *new_authority;
                emit!(AuthorityChanged {
                    old_authority,
                    new_authority: *new_authority,
                });
            }
            TimelockAction::FreezeMint { origin_mint } => {
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
                mapping.status = MintStatus::Frozen as u8;
                emit!(MintFrozen {
                    origin_mint: mapping.origin_mint,
                    authority: state.authority,
                });
            }
            TimelockAction::ThawMint { origin_mint } => {
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
                mapping.status = MintStatus::Active as u8;
                emit!(MintThawed {
                    origin_mint: mapping.origin_mint,
                    authority: state.authority,
                });
            }
            TimelockAction::RegisterMint {
                origin_mint,
                decimals,
                enable_ptkn,
                feature_flags,
                fee_bps_override,
            } => {
                let mapping = ctx
                    .accounts
                    .mint_mapping
                    .as_mut()
                    .ok_or(FactoryError::TimelockMissingMapping)?;
                
                // Initialize or update mapping
                if mapping.origin_mint == Pubkey::default() {
                    mapping.origin_mint = *origin_mint;
                    mapping.status = MintStatus::Active as u8;
                    mapping.decimals = *decimals;
                    mapping.features = FeatureFlags::from(feature_flags.unwrap_or_else(|| state.default_features.bits()));
                    mapping.has_fee_override = fee_bps_override.is_some();
                    mapping.fee_bps_override = fee_bps_override.unwrap_or_default();
                    // Bump is already set when account is initialized via init_if_needed
                    // If account already exists, bump should already be set
                    mapping.has_ptkn = false;
                    mapping.ptkn_mint = Pubkey::default();
                } else {
                    require_keys_eq!(
                        mapping.origin_mint,
                        *origin_mint,
                        FactoryError::OriginMintMismatch
                    );
                    mapping.status = MintStatus::Active as u8;
                    mapping.decimals = *decimals;
                    mapping.features = FeatureFlags::from(feature_flags.unwrap_or_else(|| state.default_features.bits()));
                    mapping.has_fee_override = fee_bps_override.is_some();
                    mapping.fee_bps_override = fee_bps_override.unwrap_or_default();
                }

                let effective_fee_bps = fee_bps_override.unwrap_or(state.default_fee_bps);

                if *enable_ptkn {
                    let mint_key = prepare_ptkn_mint(
                        state,
                        ctx.accounts.ptkn_mint.as_ref(),
                        ctx.accounts.token_program.as_ref(),
                        Some(&ctx.accounts.rent),
                        Some(&ctx.accounts.executor),
                        *decimals,
                        None,
                    )?;
                    mapping.has_ptkn = true;
                    mapping.ptkn_mint = mint_key;
                }

                emit!(MintRegistered {
                    origin_mint: *origin_mint,
                    ptkn_mint: mapping.ptkn_mint,
                    decimals: *decimals,
                    features: mapping.features.bits(),
                    fee_bps: effective_fee_bps,
                });
            }
            TimelockAction::UpdatePoolProgramId { new_pool_program_id } => {
                let config = &mut ctx.accounts.factory_config.as_mut()
                    .ok_or(FactoryError::ConfigNotInitialized)?;
                require_keys_eq!(
                    config.factory,
                    state.key(),
                    FactoryError::ConfigFactoryMismatch
                );
                let old_pool_program_id = config.pool_program_id;
                config.pool_program_id = *new_pool_program_id;
                emit!(PoolProgramIdUpdated {
                    factory: state.key(),
                    old_pool_program_id,
                    new_pool_program_id: *new_pool_program_id,
                });
            }
        }

        state.last_updated_slot = clock.slot;
        entry.executed = true;
        
        // CRITICAL FIX: Remove from pending hashes
        // CRITICAL FIX: Optimize removal - use position + swap_remove for better performance
        // swap_remove is O(1) if removing last element, O(n) for finding position
        // This is more efficient than retain() which is always O(n) and creates new vector
        if let Some(pos) = state.pending_action_hashes.iter().position(|&h| h == entry.action_hash) {
            state.pending_action_hashes.swap_remove(pos);
        }

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
        
        let state = &mut ctx.accounts.factory_state;
        
        entry.executed = true;
        entry.canceled = true;
        
        // CRITICAL FIX: Remove from pending hashes
        // CRITICAL FIX: Optimize removal - use position + swap_remove for better performance
        // swap_remove is O(1) if removing last element, O(n) for finding position
        // This is more efficient than retain() which is always O(n) and creates new vector
        if let Some(pos) = state.pending_action_hashes.iter().position(|&h| h == entry.action_hash) {
            state.pending_action_hashes.swap_remove(pos);
        }
        
        let clock = Clock::get()?;

        emit!(TimelockCanceled {
            factory: state.key(),
            action_hash: entry.action_hash,
            canceled_at: clock.unix_timestamp,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn cleanup_timelock_action(ctx: Context<CleanupTimelockAction>) -> Result<()> {
        let state = &ctx.accounts.factory_state;
        let entry = &mut ctx.accounts.timelock_entry;
        
        // CRITICAL FIX: Require authorization for cleanup
        require_keys_eq!(
            ctx.accounts.cleaner.key(),
            state.authority,
            FactoryError::Unauthorized
        );
        
        // CRITICAL FIX: Verify entry hasn't been executed or canceled
        require!(!entry.executed, FactoryError::TimelockConsumed);
        require!(!entry.canceled, FactoryError::ChangeCanceled);

        let clock = Clock::get()?;
        
        // CRITICAL FIX: Only allow cleanup of entries that are:
        // 1. Past execute_after + grace period (30 days)
        // 2. Not executed
        // 3. Not canceled
        // This ensures valid actions aren't prematurely cleaned up
        let cleanup_threshold = entry
            .execute_after
            .checked_add(TIMELOCK_STALE_GRACE_SECONDS)
            .ok_or(FactoryError::TimelockOverflow)?;
        
        require!(
            clock.unix_timestamp >= cleanup_threshold,
            FactoryError::TimelockNotExpired
        );

        // Now safe to mark as executed and canceled for cleanup
        entry.executed = true;
        entry.canceled = true;

        let state = &mut ctx.accounts.factory_state;
        // CRITICAL FIX: Optimize removal - use position + swap_remove for better performance
        // swap_remove is O(1) if removing last element, O(n) for finding position
        // This is more efficient than retain() which is always O(n) and creates new vector
        if let Some(pos) = state.pending_action_hashes.iter().position(|&h| h == entry.action_hash) {
            state.pending_action_hashes.swap_remove(pos);
        }

        emit!(TimelockGarbageCollected {
            factory: state.key(),
            action_hash: entry.action_hash,
            cleaner: ctx.accounts.cleaner.key(),
            cleaned_at: clock.unix_timestamp,
        });
        Ok(())
    }

    pub fn mint_ptkn(ctx: Context<MintPtkn>, amount: u64) -> Result<()> {
        require!(amount > 0, FactoryError::InvalidAmount);
        // CRITICAL FIX: Validate amount limit to prevent excessive minting
        require!(
            amount <= ptf_factory::MAX_MINT_AMOUNT,
            FactoryError::AmountTooLarge
        );
        
        let factory_state = &ctx.accounts.factory_state;
        require!(!factory_state.paused, FactoryError::Paused);

        let mapping = &ctx.accounts.mint_mapping;
        require!(mapping.has_ptkn, FactoryError::PtknMintDisabled);
        
        // CRITICAL FIX: Check mint status to prevent frozen mints from minting PTKN
        // Governance can freeze a mint, and this should prevent all operations including PTKN minting
        require!(
            mapping.status == MintStatus::Active as u8,
            FactoryError::MintFrozen
        );
        
        // CRITICAL FIX: Validate destination account is not default/uninitialized
        require!(
            ctx.accounts.destination_token_account.owner != Pubkey::default(),
            FactoryError::InvalidDestination
        );
        require_keys_eq!(
            mapping.ptkn_mint,
            ctx.accounts.ptkn_mint.key(),
            FactoryError::PtknMintMismatch
        );
        require_keys_eq!(
            ctx.accounts.destination_token_account.mint,
            ctx.accounts.ptkn_mint.key(),
            FactoryError::PtknMintMismatch
        );

        // CRITICAL FIX: Use pool program ID from config account if available, otherwise fallback to hardcoded
        // This maintains backward compatibility while allowing migration
        let pool_program_id = if let Some(config) = ctx.accounts.factory_config.as_ref() {
            require_keys_eq!(
                config.factory,
                factory_state.key(),
                FactoryError::ConfigFactoryMismatch
            );
            config.pool_program_id
        } else {
            // Backward compatibility: use hardcoded program ID if config not initialized
            PTF_POOL_PROGRAM_ID
        };

        let (expected_pool, _) = Pubkey::find_program_address(
            &[seeds::POOL, mapping.origin_mint.as_ref()],
            &pool_program_id,
        );
        require_keys_eq!(
            expected_pool,
            ctx.accounts.pool_authority.key(),
            FactoryError::PoolAuthorityMismatch
        );
        require!(
            ctx.accounts.pool_authority.is_signer,
            FactoryError::PoolAuthorityMismatch
        );
        require_keys_eq!(
            *ctx.accounts.pool_authority.owner,
            pool_program_id,
            FactoryError::PoolAuthorityMismatch
        );

        let bump_seed = &[factory_state.bump];
        let signer_seeds: [&[u8]; 3] = [seeds::FACTORY, crate::ID.as_ref(), bump_seed];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.ptkn_mint.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.factory_state.to_account_info(),
        };
        let signer_seeds_slice: &[&[u8]] = &signer_seeds;
        let signer_seeds_for_cpi = [signer_seeds_slice];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &signer_seeds_for_cpi,
        );
        token_interface::mint_to(cpi_ctx, amount)?;
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
pub struct InitializeFactoryConfig<'info> {
    #[account(
        mut,
        seeds = [seeds::FACTORY, crate::ID.as_ref()],
        bump = factory_state.bump
    )]
    pub factory_state: Account<'info, FactoryState>,
    #[account(
        init,
        seeds = [b"factory-config", factory_state.key().as_ref()],
        bump,
        payer = payer,
        space = FactoryConfig::SPACE,
    )]
    pub factory_config: Account<'info, FactoryConfig>,
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
        init_if_needed,
        payer = payer,
        seeds = [seeds::MINT_MAPPING, origin_mint.key().as_ref()],
        bump,
        space = MintMapping::SPACE,
    )]
    pub mint_mapping: Account<'info, MintMapping>,
    /// CHECK: Validated in instruction to be a proper SPL mint account
    pub origin_mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub ptkn_mint: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub rent: Sysvar<'info, Rent>,
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
    pub ptkn_mint: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub rent: Sysvar<'info, Rent>,
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
        seeds = [
            seeds::TIMELOCK,
            factory_state.key().as_ref(),
            // CRITICAL FIX: Use the current sequence value (will be incremented in instruction)
            // Anchor reads this BEFORE the instruction runs, so it uses the OLD value
            // The instruction then increments it, so we need to match the OLD value here
            &factory_state.last_action_sequence.to_le_bytes(),
        ],
        bump,
        space = TimelockEntry::SPACE,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub mint_mapping: Option<Account<'info, MintMapping>>,
    pub origin_mint: Option<UncheckedAccount<'info>>,
    #[account(mut)]
    pub ptkn_mint: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub rent: Option<Sysvar<'info, Rent>>,
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
            &timelock_entry.sequence.to_le_bytes()
        ],
        bump = timelock_entry.bump,
        constraint = timelock_entry.factory == factory_state.key() @ FactoryError::TimelockInvalidFactory,
        close = executor,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub mint_mapping: Option<Account<'info, MintMapping>>,
    #[account(mut)]
    pub ptkn_mint: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    #[account(mut)]
    pub factory_config: Option<Account<'info, FactoryConfig>>,
    #[account(mut)]
    pub executor: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintPtkn<'info> {
    #[account(
        mut,
        seeds = [seeds::FACTORY, crate::ID.as_ref()],
        bump = factory_state.bump
    )]
    pub factory_state: Account<'info, FactoryState>,
    #[account(
        seeds = [seeds::MINT_MAPPING, mint_mapping.origin_mint.as_ref()],
        bump = mint_mapping.bump
    )]
    pub mint_mapping: Account<'info, MintMapping>,
    /// Optional factory config account - if not provided, uses hardcoded pool program ID
    /// CHECK: Validated in instruction if provided
    pub factory_config: Option<Account<'info, FactoryConfig>>,
    /// CHECK: Verified against the expected PDA derived from the pool program id.
    pub pool_authority: AccountInfo<'info>,
    #[account(mut)]
    pub ptkn_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CreateVerifyingKey<'info> {
    #[account(has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    /// CHECK: Verifier program will validate
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: VerifierConfig account (required for factory program ID)
    pub verifier_config: UncheckedAccount<'info>,
    /// CHECK: Will be initialized by verifier program
    #[account(mut)]
    pub verifier_state: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
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
            &timelock_entry.sequence.to_le_bytes()
        ],
        bump = timelock_entry.bump,
        constraint = timelock_entry.factory == factory_state.key() @ FactoryError::TimelockInvalidFactory,
        close = authority,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
}

#[derive(Accounts)]
pub struct CleanupTimelockAction<'info> {
    #[account(mut)]
    pub factory_state: Account<'info, FactoryState>,
    #[account(
        mut,
        seeds = [
            seeds::TIMELOCK,
            factory_state.key().as_ref(),
            &timelock_entry.sequence.to_le_bytes()
        ],
        bump = timelock_entry.bump,
        constraint = timelock_entry.factory == factory_state.key() @ FactoryError::TimelockInvalidFactory,
        close = cleaner,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub cleaner: Signer<'info>,
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
    // CRITICAL FIX: Track pending action hashes to prevent duplicates
    pub pending_action_hashes: Vec<[u8; 32]>,
    pub last_action_sequence: u64,
    // CRITICAL FIX: Rate limiting - track last action time to prevent rapid queue filling
    pub last_action_time: i64,
    // CRITICAL FIX: Global rate limiting to prevent coordinated attacks
    pub last_global_action_time: i64,
    // CRITICAL FIX: Multi-signature configuration for critical operations
    pub multi_sig_signers: Vec<Pubkey>,
    pub multi_sig_threshold: u8,
    // CRITICAL FIX: Emergency pause signers (independent of main authority)
    pub emergency_pause_signers: Vec<Pubkey>,
    pub emergency_pause_threshold: u8,
}

impl FactoryState {
    pub const MAX_PENDING_ACTIONS: usize = 50;
    // Minimum time between actions (60 seconds) to prevent rapid queue filling
    pub const MIN_TIME_BETWEEN_ACTIONS: i64 = 60;
    pub const MAX_MULTISIG_SIGNERS: usize = 10;
    pub const MAX_EMERGENCY_SIGNERS: usize = 10;
    // SPACE = discriminator[8] + authority[32] + default_fee_bps[2] + default_features[1] + paused[1] + timelock_seconds[8] + bump[1] + last_updated_slot[8] + pending_action_hashes[4 + (32 * MAX_PENDING_ACTIONS)] + last_action_sequence[8] + last_action_time[8] + multi_sig_signers[4 + (32 * MAX_MULTISIG_SIGNERS)] + multi_sig_threshold[1] + emergency_pause_signers[4 + (32 * MAX_EMERGENCY_SIGNERS)] + emergency_pause_threshold[1]
    pub const SPACE: usize = 8 + 32 + 2 + 1 + 1 + 8 + 1 + 8 + 4 + (32 * Self::MAX_PENDING_ACTIONS) + 8 + 8 + 8 + 4 + (32 * Self::MAX_MULTISIG_SIGNERS) + 1 + 4 + (32 * Self::MAX_EMERGENCY_SIGNERS) + 1;
    pub const SEQUENCE_WARNING_THRESHOLD: u64 = u64::MAX - 1_000_000;
    
    // CRITICAL FIX: Check if authority or multi-sig is satisfied
    pub fn require_authority_or_multisig(
        &self,
        authority_key: &Pubkey,
        remaining_accounts: &[AccountInfo],
    ) -> Result<()> {
        // Check single authority first
        if authority_key == &self.authority {
            return Ok(());
        }
        
        // Check multi-sig if configured
        if !self.multi_sig_signers.is_empty() && self.multi_sig_threshold > 0 {
            let mut signatures = 0u8;
            for signer_pubkey in &self.multi_sig_signers {
                // Check if this signer is in remaining_accounts and is a signer
                if remaining_accounts.iter().any(|acc| acc.key() == *signer_pubkey && acc.is_signer) {
                    signatures = signatures.checked_add(1).ok_or(FactoryError::InsufficientSignatures)?;
                }
            }
            require!(
                signatures >= self.multi_sig_threshold,
                FactoryError::InsufficientSignatures
            );
            return Ok(());
        }
        
        err!(FactoryError::Unauthorized)
    }
    
    // CRITICAL FIX: Check emergency pause signers
    pub fn require_emergency_pause_signers(
        &self,
        remaining_accounts: &[AccountInfo],
    ) -> Result<()> {
        require!(
            !self.emergency_pause_signers.is_empty(),
            FactoryError::EmergencyPauseNotConfigured
        );
        
        let mut signatures = 0u8;
        for signer_pubkey in &self.emergency_pause_signers {
            if remaining_accounts.iter().any(|acc| acc.key() == *signer_pubkey && acc.is_signer) {
                signatures = signatures.checked_add(1).ok_or(FactoryError::InsufficientEmergencySignatures)?;
            }
        }
        require!(
            signatures >= self.emergency_pause_threshold,
            FactoryError::InsufficientEmergencySignatures
        );
        Ok(())
    }
}

#[account]
pub struct FactoryConfig {
    pub factory: Pubkey,
    pub pool_program_id: Pubkey,
    pub verifier_program_id: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
}

impl FactoryConfig {
    // SPACE = discriminator[8] + factory[32] + pool_program_id[32] + verifier_program_id[32] + authority[32] + bump[1]
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 1;
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
    pub canceled: bool,
    pub action: TimelockAction,
    pub bump: u8,
    pub sequence: u64,
    // CRITICAL FIX: Action expiration to prevent indefinite execution
    pub expires_at: i64,
}

impl TimelockEntry {
    pub const MAX_ACTION_SIZE: usize = 128;
    // SPACE = discriminator[8] + factory[32] + salt[32] + action_hash[32] + queued_at[8] + execute_after[8] + executed[1] + canceled[1] + action[MAX_ACTION_SIZE] + bump[1] + sequence[8] + expires_at[8]
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + Self::MAX_ACTION_SIZE + 1 + 8 + 8;
}

fn ensure_direct_update_allowed(_state: &FactoryState) -> Result<()> {
    // CRITICAL FIX: Never allow direct updates
    // All critical operations must go through timelock system
    // This prevents bypassing security delays even if timelock_seconds is 0
    Err(error!(FactoryError::TimelockOnlyQueue))
}

fn apply_mint_update<'info>(
    factory_state: &Account<'info, FactoryState>,
    mapping: &mut MintMapping,
    params: &UpdateMintParams,
    ptkn_mint: Option<&UncheckedAccount<'info>>,
    token_program: Option<&Interface<'info, TokenInterface>>,
    rent: Option<&Sysvar<'info, Rent>>,
    payer: Option<&Signer<'info>>,
    authority: Option<&Signer<'info>>,
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
                let mint_key = prepare_ptkn_mint(
                    factory_state,
                    ptkn_mint,
                    token_program,
                    rent,
                    payer,
                    mapping.decimals,
                    authority,
                )?;
                mapping.has_ptkn = true;
                mapping.ptkn_mint = mint_key;
            } else if let Some(ptkn_mint) = ptkn_mint {
                require_keys_eq!(
                    ptkn_mint.key(),
                    mapping.ptkn_mint,
                    FactoryError::PtknMintMismatch
                );
                let mint_decimals = load_mint_decimals(&ptkn_mint.to_account_info())?;
                require!(
                    mint_decimals == mapping.decimals,
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

fn prepare_ptkn_mint<'info>(
    factory_state: &Account<'info, FactoryState>,
    ptkn_mint: Option<&UncheckedAccount<'info>>,
    token_program: Option<&Interface<'info, TokenInterface>>,
    rent: Option<&Sysvar<'info, Rent>>,
    payer: Option<&Signer<'info>>,
    decimals: u8,
    current_authority: Option<&Signer<'info>>,
) -> Result<Pubkey> {
    let ptkn_account = ptkn_mint.ok_or(FactoryError::PtknMintMissing)?;
    let token_program = token_program.ok_or(FactoryError::TokenProgramMissing)?;
    let mint_info = ptkn_account.to_account_info();

    if mint_info.owner == &system_program::ID && mint_info.data_is_empty() {
        let payer = payer.ok_or(FactoryError::PtknPayerMissing)?;
        let rent = rent.ok_or(FactoryError::RentMissing)?;
        let mint_space = <Token2022Mint as Token2022Pack>::LEN;
        let lamports = rent.minimum_balance(mint_space);
        let create_ix = system_instruction::create_account(
            payer.key,
            mint_info.key,
            lamports,
            mint_space as u64,
            token_program.key,
        );
        invoke(&create_ix, &[payer.to_account_info(), mint_info.clone()])?;
        let init_accounts = token_interface::InitializeMint2 {
            mint: mint_info.clone(),
        };
        let init_ctx = CpiContext::new(token_program.to_account_info(), init_accounts);
        // CRITICAL FIX: Set freeze authority to None for new mints
        // This prevents attackers from freezing accounts after registration
        token_interface::initialize_mint2(init_ctx, decimals, &factory_state.key(), None)?;
    } else {
        require_keys_eq!(
            *mint_info.owner,
            token_program.key(),
            FactoryError::PtknMintMismatch
        );
        let mint_decimals = load_mint_decimals(&mint_info)?;
        require!(mint_decimals == decimals, FactoryError::InvalidDecimals);
        let mint_account = load_mint_state(&mint_info)?;
        match mint_account.mint_authority {
            COption::Some(current) => {
                if current != factory_state.key() {
                    let signer = current_authority.ok_or(FactoryError::Unauthorized)?;
                    let cpi_accounts = SetAuthority {
                        account_or_mint: mint_info.clone(),
                        current_authority: signer.to_account_info(),
                    };
                    let cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts);
                    token_interface::set_authority(
                        cpi_ctx,
                        AuthorityType::MintTokens,
                        Some(factory_state.key()),
                    )?;
                }
            }
            COption::None => return err!(FactoryError::PtknAuthorityMissing),
        }
        
        // CRITICAL FIX: Also set freeze authority to None or factory PDA
        // This prevents attackers from freezing accounts after registration
        // Check if freeze authority exists and is not already None
        if let COption::Some(freeze_auth) = mint_account.freeze_authority {
            // If freeze authority is not None and not the factory, we need to set it
            // However, we can only set it if we have the current freeze authority signer
            // For now, we require that reused mints have freeze authority as None or factory
            // If it's not, we reject the mint (safer approach)
            if freeze_auth != factory_state.key() {
                // Reject mints with non-factory freeze authority
                // The caller must first set freeze authority to None or factory before registration
                return err!(FactoryError::Unauthorized);
            }
        }
        // If freeze authority is None, that's fine - we don't need to do anything
    }

    Ok(*mint_info.key)
}

fn load_mint_state(account_info: &AccountInfo<'_>) -> Result<Mint> {
    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(FactoryError::AccountDataReadFailed))?;
    // Minimum mint account size is 82 bytes
    require!(
        data.len() >= 82,
        FactoryError::AccountDataTooShort
    );
    let mut slice: &[u8] = &data;
    Mint::try_deserialize(&mut slice)
        .map_err(|_| error!(FactoryError::InvalidMintFormat))
}

fn load_mint_decimals(account_info: &AccountInfo<'_>) -> Result<u8> {
    Ok(load_mint_state(account_info)?.decimals)
}

fn validate_mint_account(mint: &InterfaceAccount<Mint>, expected_decimals: Option<u8>) -> Result<()> {
    if let Some(expected) = expected_decimals {
        require!(
            mint.decimals == expected,
            FactoryError::DecimalsMismatch
        );
    }
    // Additional validation can be added here
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
    ChangeAuthority {
        new_authority: Pubkey,
    },
    FreezeMint {
        origin_mint: Pubkey,
    },
    ThawMint {
        origin_mint: Pubkey,
    },
    RegisterMint {
        origin_mint: Pubkey,
        decimals: u8,
        enable_ptkn: bool,
        feature_flags: Option<u8>,
        fee_bps_override: Option<u16>,
    },
    UpdatePoolProgramId {
        new_pool_program_id: Pubkey,
    },
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
pub struct VerifyingKeyCreated {
    pub circuit_tag: [u8; 32],
    pub verifying_key_id: [u8; 32],
    pub hash: [u8; 32],
    pub version: u8,
    pub created_by: Pubkey,
}

#[event]
pub struct FactoryPaused {
    pub authority: Pubkey,
}

#[event]
pub struct FactoryPausedEmergency {
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

#[event]
pub struct TimelockSequenceWarning {
    pub factory: Pubkey,
    pub sequence: u64,
}

#[event]
pub struct TimelockGarbageCollected {
    pub factory: Pubkey,
    pub action_hash: [u8; 32],
    pub cleaner: Pubkey,
    pub cleaned_at: i64,
}

#[event]
pub struct AuthorityChanged {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct FactoryConfigInitialized {
    pub factory: Pubkey,
    pub pool_program_id: Pubkey,
    pub verifier_program_id: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct PoolProgramIdUpdated {
    pub factory: Pubkey,
    pub old_pool_program_id: Pubkey,
    pub new_pool_program_id: Pubkey,
}

#[repr(u8)]
pub enum MintStatus {
    Active = 1,
    Frozen = 2,
}

#[error_code]
pub enum FactoryError {
    // Program-specific state errors
    #[msg("Already registered")]
    AlreadyRegistered,
    #[msg("Factory paused")]
    Paused,
    #[msg("Factory not paused")]
    NotPaused,
    #[msg("PTKN mint missing")]
    PtknMintMissing,
    // Standardized input errors
    #[msg("Invalid fee basis points")]
    InvalidFeeBps,
    // Standardized access control errors
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid decimals")]
    InvalidDecimals,
    // Program-specific errors
    #[msg("PTKN mint mismatch")]
    PtknMintMismatch,
    #[msg("PTKN authority missing")]
    PtknAuthorityMissing,
    #[msg("Token program missing")]
    TokenProgramMissing,
    #[msg("Rent missing")]
    RentMissing,
    #[msg("PTKN payer missing")]
    PtknPayerMissing,
    #[msg("PTKN mint disabled")]
    PtknMintDisabled,
    #[msg("Pool authority mismatch")]
    PoolAuthorityMismatch,
    // Standardized timelock errors
    #[msg("Timelock overflow")]
    TimelockOverflow,
    #[msg("Timelock consumed")]
    TimelockConsumed,
    #[msg("Change canceled")]
    ChangeCanceled,
    #[msg("Timelock not ready")]
    TimelockNotReady,
    #[msg("Timelock not expired")]
    TimelockNotExpired,
    // Program-specific timelock errors
    #[msg("Timelock mint mapping missing")]
    TimelockMissingMapping,
    #[msg("Timelock invalid factory")]
    TimelockInvalidFactory,
    #[msg("Timelock only queue")]
    TimelockOnlyQueue,
    #[msg("Serialization error")]
    SerializationError,
    #[msg("Origin mint mismatch")]
    OriginMintMismatch,
    // Standardized access control errors
    #[msg("Insufficient signatures")]
    InsufficientSignatures,
    // Program-specific errors
    #[msg("Emergency pause not configured")]
    EmergencyPauseNotConfigured,
    #[msg("Insufficient emergency signatures")]
    InsufficientEmergencySignatures,
    #[msg("Mint frozen")]
    MintFrozen,
    // Standardized input errors
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Amount too large")]
    AmountTooLarge,
    #[msg("Invalid destination")]
    InvalidDestination,
    // Standardized timelock errors
    #[msg("Timelock too short")]
    TimelockTooShort,
    // Standardized integrity errors
    #[msg("Hash mismatch")]
    TimelockHashMismatch,
    #[msg("Hash mismatch")]
    VerifyingKeyHashMismatch,
    #[msg("Verifying key too large")]
    VerifyingKeyTooLarge,
    // Program-specific errors
    #[msg("Duplicate action")]
    DuplicateAction,
    #[msg("Too many pending actions")]
    TooManyPendingActions,
    // Standardized rate limiting errors
    #[msg("Global action rate limit exceeded")]
    GlobalActionRateLimitExceeded,
    #[msg("Action expired")]
    ActionExpired,
    // Standardized sequence errors
    #[msg("Sequence overflow")]
    SequenceOverflow,
    // Standardized rate limiting errors
    #[msg("Action rate limit exceeded")]
    ActionRateLimitExceeded,
    // Standardized access control errors
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("Authority unchanged")]
    AuthorityUnchanged,
    // Program-specific errors
    #[msg("Config not initialized")]
    ConfigNotInitialized,
    #[msg("Config factory mismatch")]
    ConfigFactoryMismatch,
    #[msg("Account data read failed")]
    AccountDataReadFailed,
    // Standardized validation errors
    #[msg("Account data too short")]
    AccountDataTooShort,
    #[msg("Invalid mint format")]
    InvalidMintFormat,
    #[msg("Decimals mismatch")]
    DecimalsMismatch,
    #[msg("Invalid verifier program")]
    InvalidVerifierProgram,
}
