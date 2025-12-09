use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self as token_interface, Mint, TokenAccount, TokenInterface, Transfer,
};
use solana_program::pubkey;

use ptf_common::seeds;
use ptf_common::addresses::AddressDeriver;
use ptf_common::security::{
    AccountIntegrity, IntegrityChecker, RateLimitConfig, RateLimiterState,
};
use ptf_common::security::events::{emit_security_event, SecurityEventType, SecuritySeverity};
use ptf_common::security::patterns::validate_then_execute;

declare_id!("Muko1fue2j1At1U6v2xJ7cuwas5uSUjZHVGppbpT8yq");

const PTF_POOL_PROGRAM_ID: Pubkey = pubkey!("Av2D8ADegRt1zTfqEABidkcMH2zzusrDLwAeDFgfdQ1k");
// CRITICAL FIX: Timelock duration for authority changes (7 days)
const TIMELOCK_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60; // 7 days
// CRITICAL FIX: Pending change expiration (30 days after execution time)
const PENDING_CHANGE_EXPIRATION_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days
// CRITICAL FIX: Rate limiting for authority changes (minimum 30 days between changes)
const AUTHORITY_CHANGE_RATE_LIMIT_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days
// CRITICAL FIX: Lock timeout (5 minutes)
const LOCK_TIMEOUT_SECONDS: i64 = 300; // 5 minutes
// CRITICAL FIX: Token program IDs
const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SPL_TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Rate limiting configuration (per vault / origin mint)
const DEPOSIT_RATE_LIMIT_CONFIG: RateLimitConfig = RateLimitConfig {
    // At most 120 deposits per minute with at least 1 second between deposits.
    min_time_between_actions: 1,
    max_actions_per_window: 120,
    window_duration: 60,
};
const RELEASE_RATE_LIMIT_CONFIG: RateLimitConfig = RateLimitConfig {
    // Releases are more sensitive: 30 per minute, 2 seconds apart.
    min_time_between_actions: 2,
    max_actions_per_window: 30,
    window_duration: 60,
};

#[program]
pub mod ptf_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, pool_authority: Pubkey) -> Result<()> {
        // CRITICAL FIX: Validate origin_mint is a valid token mint
        // InterfaceAccount already validates it's a mint, but check decimals
        require!(
            ctx.accounts.origin_mint.decimals <= 18,
            VaultError::InvalidMint
        );
        
        // PROGRAM-LEVEL ADDRESS DERIVATION: Derive all PDAs from origin_mint
        let origin_mint_key = ctx.accounts.origin_mint.key();
        msg!("initialize_vault: deriving addresses from origin_mint={}", origin_mint_key);
        
        // Derive pool_authority PDA
        let (expected_pool_authority, _expected_bump) = AddressDeriver::derive_pool_state(
            &origin_mint_key,
            &PTF_POOL_PROGRAM_ID,
        );
        require_keys_eq!(
            pool_authority,
            expected_pool_authority,
            VaultError::InvalidPoolAuthority
        );
        
        // CRITICAL FIX: Validate bump matches actual PDA derivation
        let (expected_vault_pda, expected_vault_bump) = AddressDeriver::derive_vault_state(
            &origin_mint_key,
            &crate::ID,
        );
        require_keys_eq!(
            ctx.accounts.vault_state.key(),
            expected_vault_pda,
            VaultError::InvalidBump
        );
        require!(
            ctx.bumps.vault_state == expected_vault_bump,
            VaultError::InvalidBump
        );
        
        let state = &mut ctx.accounts.vault_state;
        state.origin_mint = ctx.accounts.origin_mint.key();
        state.pool_authority = pool_authority;
        state.bump = expected_vault_bump; // Use validated bump
        state.locked = false; // Initialize reentrancy guard
        state.lock_timestamp = None;
        state.authority_change_sequence = 0;
        state.last_authority_change_time = None;
        state.deposit_rate_limit = RateLimiterState::default();
        state.release_rate_limit = RateLimiterState::default();
        refresh_vault_state_integrity(state);
        emit_security_event(
            SecurityEventType::StateTransition,
            ctx.accounts.payer.key(),
            format!("Initialized vault for mint {}", state.origin_mint),
            SecuritySeverity::Low,
        );
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidDepositAmount);
        
        // CRITICAL FIX: Validate token program
        validate_token_program(&ctx.accounts.token_program.key())?;

        let vault_state = &mut ctx.accounts.vault_state;

        verify_vault_state(vault_state)?;

        // Apply per-mint deposit rate limiting.
        let clock = Clock::get()?;
        vault_state
            .deposit_rate_limit
            .check(&DEPOSIT_RATE_LIMIT_CONFIG, &clock)?;
        refresh_vault_state_integrity(vault_state);
        
        // CRITICAL FIX: Enhanced reentrancy guard with timeout
        acquire_lock(vault_state)?;
        
        // Use defer-like pattern to ensure lock is always released
        let result = (|| -> Result<()> {
            validate_then_execute(
                || {
                    // CRITICAL FIX: Validate vault token account owner is vault PDA
                    let (expected_vault_pda, _) = AddressDeriver::derive_vault_state(
                        &vault_state.origin_mint,
                        &crate::ID,
                    );
                    require_keys_eq!(
                        ctx.accounts.vault_token_account.owner,
                        expected_vault_pda,
                        VaultError::InvalidVaultAccount
                    );
                    
                    // CRITICAL FIX: Validate vault token account mint matches origin_mint
                    require_keys_eq!(
                        ctx.accounts.vault_token_account.mint,
                        vault_state.origin_mint,
                        VaultError::InvalidMint,
                    );
                    
                    // CRITICAL FIX: Validate depositor token account owner is depositor
                    require_keys_eq!(
                        ctx.accounts.depositor_token_account.owner,
                        ctx.accounts.depositor.key(),
                        VaultError::InvalidDepositorAccount
                    );
                    
                    // CRITICAL FIX: Validate depositor token account mint matches origin_mint
                    require_keys_eq!(
                        ctx.accounts.depositor_token_account.mint,
                        vault_state.origin_mint,
                        VaultError::InvalidMint
                    );
                    Ok(())
                },
                || {
                    let cpi_accounts = Transfer {
                        from: ctx.accounts.depositor_token_account.to_account_info(),
                        to: ctx.accounts.vault_token_account.to_account_info(),
                        authority: ctx.accounts.depositor.to_account_info(),
                    };
                    let cpi_ctx =
                        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
                    
                    #[allow(deprecated)]
                    token_interface::transfer(cpi_ctx, amount)?;

                    emit!(VaultDeposit {
                        origin_mint: vault_state.origin_mint,
                        depositor: ctx.accounts.depositor.key(),
                        amount,
                    });
                    Ok(())
                },
            )
        })();
        
        release_lock(vault_state);
        refresh_vault_state_integrity(vault_state);
        emit_security_event(
            SecurityEventType::StateTransition,
            ctx.accounts.depositor.key(),
            format!(
                "Deposit {} into vault {}",
                amount,
                vault_state.origin_mint
            ),
            SecuritySeverity::Low,
        );
        result
    }

    pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidReleaseAmount);
        
        // CRITICAL FIX: Validate token program
        validate_token_program(&ctx.accounts.token_program.key())?;
        
        // Cache values before mutable borrow
        let origin_mint = ctx.accounts.vault_state.origin_mint;
        let pool_authority = ctx.accounts.vault_state.pool_authority;
        let stored_bump = ctx.accounts.vault_state.bump;
        
        // PROGRAM-LEVEL ADDRESS DERIVATION: Derive vault_state PDA from origin_mint
        let (expected_vault_pda, expected_bump) = AddressDeriver::derive_vault_state(
            &origin_mint,
            &crate::ID,
        );
        require_keys_eq!(
            ctx.accounts.vault_state.key(),
            expected_vault_pda,
            VaultError::InvalidBump
        );
        require!(
            stored_bump == expected_bump,
            VaultError::InvalidBump
        );
        
        let vault_state = &mut ctx.accounts.vault_state;

        verify_vault_state(vault_state)?;

        // Apply per-mint release rate limiting.
        let clock = Clock::get()?;
        vault_state
            .release_rate_limit
            .check(&RELEASE_RATE_LIMIT_CONFIG, &clock)?;
        refresh_vault_state_integrity(vault_state);
        
        // CRITICAL FIX: Enhanced reentrancy guard with timeout
        acquire_lock(vault_state)?;
        
        // Use defer-like pattern to ensure lock is always released
        let result = (|| -> Result<()> {
            validate_then_execute(
                || {
                    validate_pool_authority(&ctx.accounts.pool_authority, &pool_authority)?;
                    
                    // CRITICAL FIX: Validate vault token account owner is vault PDA
                    let (expected_vault_pda, _) = AddressDeriver::derive_vault_state(
                        &origin_mint,
                        &crate::ID,
                    );
                    require_keys_eq!(
                        ctx.accounts.vault_token_account.owner,
                        expected_vault_pda,
                        VaultError::InvalidVaultAccount
                    );
                    
                    // CRITICAL FIX: Validate vault token account mint matches origin_mint
                    require_keys_eq!(
                        ctx.accounts.vault_token_account.mint,
                        origin_mint,
                        VaultError::InvalidMint
                    );
                    
                    // CRITICAL FIX: Validate destination token account mint matches origin_mint
                    require_keys_eq!(
                        ctx.accounts.destination_token_account.mint,
                        origin_mint,
                        VaultError::InvalidMint
                    );

                    // CRITICAL FIX: Explicitly validate vault has sufficient balance before releasing
                    let balance_before = ctx.accounts.vault_token_account.amount;
                    require!(
                        balance_before >= amount,
                        VaultError::InsufficientBalance
                    );
                    
                    // CRITICAL FIX: Validate amount is reasonable to prevent overflow attacks
                    const MAX_RELEASE_AMOUNT: u64 = 1_000_000_000_000_000; // 1 quadrillion
                    require!(
                        amount <= MAX_RELEASE_AMOUNT,
                        VaultError::InvalidReleaseAmount
                    );
                    Ok(())
                },
                || {
                    let seeds = &[
                        seeds::VAULT,
                        origin_mint.as_ref(),
                        &[expected_bump], // Use validated bump
                    ];
                    let signer = &[&seeds[..]];
                    let cpi_accounts = Transfer {
                        from: ctx.accounts.vault_token_account.to_account_info(),
                        to: ctx.accounts.destination_token_account.to_account_info(),
                        authority: vault_state.to_account_info(),
                    };
                    let cpi_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        cpi_accounts,
                        signer,
                    );
                    
                    #[allow(deprecated)]
                    token_interface::transfer(cpi_ctx, amount)?;
                    
                    emit!(VaultRelease {
                        origin_mint,
                        destination: ctx.accounts.destination_token_account.owner,
                        amount,
                    });
                    Ok(())
                },
            )
        })();
        
        release_lock(vault_state);
        refresh_vault_state_integrity(vault_state);
        emit_security_event(
            SecurityEventType::StateTransition,
            ctx.accounts.pool_authority.key(),
            format!(
                "Release {} from vault {}",
                amount,
                vault_state.origin_mint
            ),
            SecuritySeverity::Low,
        );
        result
    }

    // CRITICAL FIX: Removed direct set_pool_authority - replaced with timelock-based system
    // This prevents instant authority changes that could compromise the vault
    
    // NEW: Propose authority change (with timelock)
    pub fn propose_authority_change(
        ctx: Context<ProposeAuthorityChange>,
        new_pool_authority: Pubkey,
    ) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        verify_vault_state(state)?;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            state.pool_authority,
            VaultError::UnauthorizedCaller
        );
        require!(
            new_pool_authority != state.pool_authority,
            VaultError::InvalidAuthorityChange
        );
        
        // CRITICAL FIX: Validate new authority is not default
        require!(
            new_pool_authority != Pubkey::default(),
            VaultError::InvalidAuthorityChange
        );
        
        // PROGRAM-LEVEL ADDRESS DERIVATION: Derive pool_authority PDA from origin_mint
        let (expected_pool_authority, _) = AddressDeriver::derive_pool_state(
            &state.origin_mint,
            &PTF_POOL_PROGRAM_ID,
        );
        require_keys_eq!(
            new_pool_authority,
            expected_pool_authority,
            VaultError::InvalidAuthorityChange
        );
        
        // CRITICAL FIX: Rate limiting - prevent rapid authority changes
        let clock = Clock::get()?;
        if let Some(last_change) = state.last_authority_change_time {
            require!(
                clock.unix_timestamp >= last_change + AUTHORITY_CHANGE_RATE_LIMIT_SECONDS,
                VaultError::AuthorityChangeRateLimited
            );
        }
        emit_security_event(
            SecurityEventType::RateLimitHit,
            ctx.accounts.authority.key(),
            "Authority change rate limit check".to_owned(),
            SecuritySeverity::Low,
        );
        
        let execute_after = clock
            .unix_timestamp
            .checked_add(TIMELOCK_DURATION_SECONDS)
            .ok_or(VaultError::TimelockOverflow)?;
        
        // CRITICAL FIX: Set expiration (30 days after execution time)
        let expires_at = execute_after
            .checked_add(PENDING_CHANGE_EXPIRATION_SECONDS)
            .ok_or(VaultError::TimelockOverflow)?;
        
        // CRITICAL FIX: Increment sequence to prevent race conditions
        let sequence = state.authority_change_sequence
            .checked_add(1)
            .ok_or(VaultError::SequenceOverflow)?;
        state.authority_change_sequence = sequence;
        
        let pending = &mut ctx.accounts.pending_change;
        pending.vault_state = state.key();
        pending.current_authority = state.pool_authority;
        pending.new_authority = new_pool_authority;
        pending.proposed_at = clock.unix_timestamp;
        pending.execute_after = execute_after;
        pending.expires_at = expires_at;
        pending.proposed_by = ctx.accounts.authority.key();
        pending.sequence = sequence;
        pending.executed = false;
        pending.canceled = false;
        pending.bump = ctx.bumps.pending_change;
        
        // CRITICAL FIX: Compute and store integrity hash
        pending.integrity_hash = pending.compute_integrity_hash();
        
        emit!(AuthorityChangeProposed {
            vault_state: state.key(),
            origin_mint: state.origin_mint,
            current_authority: state.pool_authority,
            new_authority: new_pool_authority,
            proposed_at: clock.unix_timestamp,
            execute_after,
            expires_at,
            sequence,
            proposed_by: ctx.accounts.authority.key(),
        });
        emit_security_event(
            SecurityEventType::StateTransition,
            ctx.accounts.authority.key(),
            format!(
                "Authority change proposed for vault {}",
                state.origin_mint
            ),
            SecuritySeverity::Medium,
        );
        refresh_vault_state_integrity(state);
        Ok(())
    }

    // NEW: Execute authority change (after timelock)
    pub fn execute_authority_change(
        ctx: Context<ExecuteAuthorityChange>,
    ) -> Result<()> {
        let pending = &mut ctx.accounts.pending_change;
        require!(!pending.executed, VaultError::AlreadyExecuted);
        require!(!pending.canceled, VaultError::ChangeCanceled);
        
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= pending.execute_after,
            VaultError::TimelockNotReady
        );
        
        // CRITICAL FIX: Check expiration
        require!(
            clock.unix_timestamp < pending.expires_at,
            VaultError::ChangeExpired
        );
        
        let state = &mut ctx.accounts.vault_state;
        verify_vault_state(state)?;
        require_keys_eq!(
            pending.vault_state,
            state.key(),
            VaultError::VaultMismatch
        );
        
        // CRITICAL FIX: Verify integrity hash to prevent manipulation
        let expected_hash = pending.compute_integrity_hash();
        require!(
            expected_hash == pending.integrity_hash,
            VaultError::IntegrityCheckFailed
        );
        
        // CRITICAL FIX: Check if authority has changed since proposal (stale proposal)
        if pending.current_authority != state.pool_authority {
            // Authority changed, this proposal is stale
            return err!(VaultError::AuthorityMismatch);
        }
        
        // CRITICAL FIX: Validate sequence matches
        require!(
            pending.sequence <= state.authority_change_sequence,
            VaultError::StaleProposal
        );
        
        // CRITICAL FIX: Validate new authority is still valid
        let (expected_pool_authority, _) = AddressDeriver::derive_pool_state(
            &state.origin_mint,
            &PTF_POOL_PROGRAM_ID,
        );
        require_keys_eq!(
            pending.new_authority,
            expected_pool_authority,
            VaultError::InvalidAuthorityChange
        );
        
        let old_authority = state.pool_authority;
        state.pool_authority = pending.new_authority;
        state.last_authority_change_time = Some(clock.unix_timestamp);
        pending.executed = true;
        
        emit!(AuthorityChangeExecuted {
            vault_state: state.key(),
            origin_mint: state.origin_mint,
            old_authority,
            new_authority: pending.new_authority,
            executed_at: clock.unix_timestamp,
            executed_by: ctx.accounts.executor.key(),
            sequence: pending.sequence,
        });
        emit_security_event(
            SecurityEventType::StateTransition,
            ctx.accounts.executor.key(),
            format!(
                "Authority change executed for vault {}",
                state.origin_mint
            ),
            SecuritySeverity::Medium,
        );
        refresh_vault_state_integrity(state);
        Ok(())
    }

    // NEW: Cancel proposed authority change
    pub fn cancel_authority_change(
        ctx: Context<CancelAuthorityChange>,
    ) -> Result<()> {
        let pending = &mut ctx.accounts.pending_change;
        require!(!pending.executed, VaultError::AlreadyExecuted);
        require!(!pending.canceled, VaultError::AlreadyCanceled);
        
        let state = &ctx.accounts.vault_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            state.pool_authority,
            VaultError::UnauthorizedCaller
        );
        require_keys_eq!(
            pending.vault_state,
            state.key(),
            VaultError::VaultMismatch
        );
        
        pending.canceled = true;
        let clock = Clock::get()?;
        
        emit!(AuthorityChangeCanceled {
            vault_state: state.key(),
            origin_mint: state.origin_mint,
            canceled_at: clock.unix_timestamp,
            authority: ctx.accounts.authority.key(),
        });
        
        Ok(())
    }
    
    // CRITICAL FIX: Lock recovery function to handle stuck locks
    pub fn recover_lock(ctx: Context<RecoverLock>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault_state.pool_authority,
            VaultError::UnauthorizedCaller
        );
        
        let state = &mut ctx.accounts.vault_state;
        if state.locked {
            msg!("WARNING: Recovering stuck lock");
            release_lock(state);
            let clock = Clock::get()?;
            emit!(LockRecovered {
                vault_state: state.key(),
                recovered_at: clock.unix_timestamp,
                authority: ctx.accounts.authority.key(),
            });
        }
        
        Ok(())
    }
    
    // CRITICAL FIX: Cleanup expired pending changes
    pub fn cleanup_expired_change(
        ctx: Context<CleanupExpiredChange>,
    ) -> Result<()> {
        let pending = &ctx.accounts.pending_change;
        let clock = Clock::get()?;
        
        require!(
            clock.unix_timestamp >= pending.expires_at,
            VaultError::ChangeNotExpired
        );
        require!(!pending.executed, VaultError::AlreadyExecuted);
        require!(!pending.canceled, VaultError::AlreadyCanceled);
        
        emit!(ExpiredChangeCleaned {
            vault_state: pending.vault_state,
            cleaned_at: clock.unix_timestamp,
            cleaned_by: ctx.accounts.cleaner.key(),
        });
        
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [seeds::VAULT, origin_mint.key().as_ref()],
        bump,
        space = VaultState::SPACE,
    )]
    pub vault_state: Account<'info, VaultState>,
    /// CRITICAL FIX: Use InterfaceAccount to validate mint
    pub origin_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub origin_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub depositor_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Pool authority must be provided by the caller program.
    #[account(
        signer,
        constraint = pool_authority.key() == vault_state.pool_authority @ VaultError::UnauthorizedCaller,
        constraint = pool_authority.owner == &PTF_POOL_PROGRAM_ID @ VaultError::UnauthorizedCaller,
    )]
    pub pool_authority: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

// CRITICAL FIX: Removed SetPoolAuthority - replaced with timelock-based contexts

#[derive(Accounts)]
pub struct ProposeAuthorityChange<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump,
        space = PendingAuthorityChange::SPACE,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteAuthorityChange<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.vault_state == vault_state.key() @ VaultError::VaultMismatch,
        close = system_program, // CRITICAL FIX: Close to system program, rent is burned (prevents rent incentive attacks)
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
    #[account(mut)]
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelAuthorityChange<'info> {
    #[account(seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.vault_state == vault_state.key() @ VaultError::VaultMismatch,
        close = system_program, // CRITICAL FIX: Close to system program, rent is burned (prevents rent incentive attacks)
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecoverLock<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CleanupExpiredChange<'info> {
    #[account(seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.vault_state == vault_state.key() @ VaultError::VaultMismatch,
        constraint = Clock::get().unwrap().unix_timestamp >= pending_change.expires_at @ VaultError::ChangeNotExpired,
        close = cleaner,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    #[account(mut)]
    pub cleaner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub bump: u8,
    pub locked: bool, // Reentrancy guard
    pub lock_timestamp: Option<i64>, // CRITICAL FIX: Track when lock was acquired for timeout
    pub authority_change_sequence: u64, // CRITICAL FIX: Track authority change sequence to prevent race conditions
    pub last_authority_change_time: Option<i64>, // CRITICAL FIX: Rate limiting for authority changes
    pub deposit_rate_limit: RateLimiterState,
    pub release_rate_limit: RateLimiterState,
    pub integrity_hash: [u8; 32],
}

impl VaultState {
    // SPACE: discriminator (8) + origin_mint (32) + pool_authority (32) + bump (1) + locked (1)
    // + lock_timestamp (9) + sequence (8) + last_change_time (9) + padding (1)
    // + deposit_rate_limit (RateLimiterState::SIZE) + release_rate_limit (RateLimiterState::SIZE)
    pub const SPACE: usize =
        8 + 32 + 32 + 1 + 1 + 9 + 8 + 9 + 1 + RateLimiterState::SIZE * 2 + 32;
}

impl AccountIntegrity for VaultState {
    fn compute_integrity_hash(&self) -> [u8; 32] {
        let bump = [self.bump];
        let locked = [self.locked as u8];
        let lock_timestamp = self.lock_timestamp.unwrap_or_default().to_le_bytes();
        let seq = self.authority_change_sequence.to_le_bytes();
        let last_change_flag = [self.last_authority_change_time.is_some() as u8];
        let last_change = self.last_authority_change_time.unwrap_or_default().to_le_bytes();

        let dep_last = self.deposit_rate_limit.last_action_time.to_le_bytes();
        let dep_window = self.deposit_rate_limit.window_start.to_le_bytes();
        let dep_count = self.deposit_rate_limit.action_count.to_le_bytes();

        let rel_last = self.release_rate_limit.last_action_time.to_le_bytes();
        let rel_window = self.release_rate_limit.window_start.to_le_bytes();
        let rel_count = self.release_rate_limit.action_count.to_le_bytes();

        IntegrityChecker::hash_fields(&[
            self.origin_mint.as_ref(),
            self.pool_authority.as_ref(),
            &bump,
            &locked,
            &lock_timestamp,
            &seq,
            &last_change_flag,
            &last_change,
            &dep_last,
            &dep_window,
            &dep_count,
            &rel_last,
            &rel_window,
            &rel_count,
        ])
    }
}

// CRITICAL FIX: Pending authority change account for timelock system
#[account]
pub struct PendingAuthorityChange {
    pub vault_state: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,
    pub expires_at: i64, // CRITICAL FIX: Expiration timestamp
    pub integrity_hash: [u8; 32], // CRITICAL FIX: Hash to prevent manipulation
    pub proposed_by: Pubkey, // CRITICAL FIX: Track who proposed the change
    pub sequence: u64, // CRITICAL FIX: Sequence number to prevent race conditions
    pub executed: bool,
    pub canceled: bool,
    pub bump: u8,
}

impl PendingAuthorityChange {
    // SPACE: discriminator (8) + vault_state (32) + current_authority (32) + new_authority (32) + proposed_at (8) + execute_after (8) + expires_at (8) + integrity_hash (32) + proposed_by (32) + sequence (8) + executed (1) + canceled (1) + bump (1) + padding (6)
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 32 + 32 + 8 + 1 + 1 + 1 + 6;
    
    // CRITICAL FIX: Compute integrity hash to prevent manipulation
    pub fn compute_integrity_hash(&self) -> [u8; 32] {
        use solana_program::hash::hashv;
        let hash = hashv(&[
            self.vault_state.as_ref(),
            self.current_authority.as_ref(),
            self.new_authority.as_ref(),
            &self.execute_after.to_le_bytes(),
            &self.sequence.to_le_bytes(),
        ]);
        hash.to_bytes()
    }
}

#[event]
pub struct VaultDeposit {
    pub origin_mint: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultRelease {
    pub origin_mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

// CRITICAL FIX: Events for timelock-based authority changes
#[event]
pub struct AuthorityChangeProposed {
    pub vault_state: Pubkey,
    pub origin_mint: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,
    pub expires_at: i64,
    pub sequence: u64,
    pub proposed_by: Pubkey,
}

#[event]
pub struct AuthorityChangeExecuted {
    pub vault_state: Pubkey,
    pub origin_mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub executed_at: i64,
    pub executed_by: Pubkey,
    pub sequence: u64,
}

#[event]
pub struct LockRecovered {
    pub vault_state: Pubkey,
    pub recovered_at: i64,
    pub authority: Pubkey,
}

#[event]
pub struct ExpiredChangeCleaned {
    pub vault_state: Pubkey,
    pub cleaned_at: i64,
    pub cleaned_by: Pubkey,
}

#[event]
pub struct AuthorityChangeCanceled {
    pub vault_state: Pubkey,
    pub origin_mint: Pubkey,
    pub canceled_at: i64,
    pub authority: Pubkey,
}

fn validate_pool_authority(pool_authority: &AccountInfo<'_>, expected: &Pubkey) -> Result<()> {
    require!(pool_authority.is_signer, VaultError::UnauthorizedCaller);
    require_keys_eq!(
        pool_authority.key(),
        *expected,
        VaultError::UnauthorizedCaller
    );
    require_keys_eq!(
        *pool_authority.owner,
        PTF_POOL_PROGRAM_ID,
        VaultError::UnauthorizedCaller
    );
    Ok(())
}

// CRITICAL FIX: Validate token program is a valid SPL Token program
fn validate_token_program(program: &Pubkey) -> Result<()> {
    require!(
        program == &SPL_TOKEN_PROGRAM_ID || program == &SPL_TOKEN_2022_PROGRAM_ID,
        VaultError::InvalidTokenProgram
    );
    Ok(())
}

fn verify_vault_state(state: &VaultState) -> Result<()> {
    state.verify_integrity(&state.integrity_hash)
}

fn refresh_vault_state_integrity(state: &mut VaultState) {
    state.integrity_hash = state.compute_integrity_hash();
}

// CRITICAL FIX: Enhanced lock acquisition with timeout
fn acquire_lock(state: &mut VaultState) -> Result<()> {
    let clock = Clock::get()?;

    verify_vault_state(state)?;
    
    if state.locked {
        if let Some(lock_time) = state.lock_timestamp {
            if clock.unix_timestamp > lock_time + LOCK_TIMEOUT_SECONDS {
                // Lock timed out, release it
                msg!("WARNING: Lock timeout detected, releasing lock");
                state.locked = false;
                state.lock_timestamp = None;
            } else {
                return err!(VaultError::ReentrancyDetected);
            }
        } else {
            // Locked but no timestamp (corrupted state), reset
            msg!("WARNING: Corrupted lock state detected, resetting");
            state.locked = false;
        }
    }
    
    state.locked = true;
    state.lock_timestamp = Some(clock.unix_timestamp);
    refresh_vault_state_integrity(state);
    Ok(())
}

// CRITICAL FIX: Release lock
fn release_lock(state: &mut VaultState) {
    state.locked = false;
    state.lock_timestamp = None;
    refresh_vault_state_integrity(state);
}

#[error_code]
pub enum VaultError {
    // Standardized validation errors
    #[msg("Invalid bump seed")]
    InvalidBump,
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid amount")]
    InvalidDepositAmount,
    #[msg("Invalid amount")]
    InvalidReleaseAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Invalid vault account")]
    InvalidVaultAccount,
    #[msg("Invalid depositor account")]
    InvalidDepositorAccount,
    // Standardized security errors
    #[msg("Reentrancy detected")]
    ReentrancyDetected,
    // Standardized timelock errors
    #[msg("Timelock overflow")]
    TimelockOverflow,
    #[msg("Timelock not ready")]
    TimelockNotReady,
    #[msg("Already executed")]
    AlreadyExecuted,
    #[msg("Change canceled")]
    ChangeCanceled,
    #[msg("Vault mismatch")]
    VaultMismatch,
    #[msg("Authority mismatch")]
    AuthorityMismatch,
    #[msg("Invalid authority change")]
    InvalidAuthorityChange,
    #[msg("Already canceled")]
    AlreadyCanceled,
    // Program-specific errors
    #[msg("Invalid token program")]
    InvalidTokenProgram,
    #[msg("Invalid pool authority")]
    InvalidPoolAuthority,
    #[msg("Pending change exists")]
    PendingChangeExists,
    #[msg("Authority change rate limited")]
    AuthorityChangeRateLimited,
    #[msg("Change expired")]
    ChangeExpired,
    #[msg("Change not expired")]
    ChangeNotExpired,
    // Standardized integrity errors
    #[msg("Integrity check failed")]
    IntegrityCheckFailed,
    #[msg("Stale proposal")]
    StaleProposal,
    #[msg("Sequence overflow")]
    SequenceOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::account_info::AccountInfo;

    fn build_pool_authority_info(
        key: Pubkey,
        owner: Pubkey,
        is_signer: bool,
    ) -> AccountInfo<'static> {
        let leaked_key = Box::leak(Box::new(key));
        let leaked_owner = Box::leak(Box::new(owner));
        let lamports = Box::leak(Box::new(0u64));
        let data: &'static mut [u8] = Box::leak(Vec::new().into_boxed_slice());
        AccountInfo::new(
            leaked_key,
            is_signer,
            false,
            lamports,
            data,
            leaked_owner,
            false,
            0,
        )
    }

    #[test]
    fn pool_authority_must_be_signer() {
        let expected = Pubkey::new_unique();
        let info = build_pool_authority_info(expected, PTF_POOL_PROGRAM_ID, false);
        assert!(validate_pool_authority(&info, &expected).is_err());
    }

    #[test]
    fn pool_authority_must_have_pool_owner() {
        let expected = Pubkey::new_unique();
        let info = build_pool_authority_info(expected, Pubkey::new_unique(), true);
        assert!(validate_pool_authority(&info, &expected).is_err());
    }

    #[test]
    fn valid_pool_authority_passes() {
        let expected = Pubkey::new_unique();
        let info = build_pool_authority_info(expected, PTF_POOL_PROGRAM_ID, true);
        assert!(validate_pool_authority(&info, &expected).is_ok());
    }
}
