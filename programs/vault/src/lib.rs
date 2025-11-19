use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self as token_interface, Mint, TokenAccount, TokenInterface, Transfer,
};
use solana_program::pubkey;

use ptf_common::seeds;

declare_id!("9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh");

const PTF_POOL_PROGRAM_ID: Pubkey = pubkey!("7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh");
// CRITICAL FIX: Timelock duration for authority changes (7 days)
const TIMELOCK_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60; // 7 days

#[program]
pub mod ptf_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, pool_authority: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        state.origin_mint = ctx.accounts.origin_mint.key();
        state.pool_authority = pool_authority;
        state.bump = ctx.bumps.vault_state;
        state.locked = false; // Initialize reentrancy guard
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidDepositAmount);

        let vault_state = &mut ctx.accounts.vault_state;
        
        // REENTRANCY GUARD: Check and set lock before any external calls
        require!(!vault_state.locked, VaultError::ReentrancyDetected);
        vault_state.locked = true;
        
        require_keys_eq!(
            ctx.accounts.vault_token_account.mint,
            vault_state.origin_mint,
            VaultError::InvalidMint,
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        #[allow(deprecated)]
        token_interface::transfer(cpi_ctx, amount)?;

        // Release lock after successful transfer
        vault_state.locked = false;

        emit!(VaultDeposit {
            origin_mint: vault_state.origin_mint,
            depositor: ctx.accounts.depositor.key(),
            amount,
        });
        Ok(())
    }

    pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidReleaseAmount);
        
        // Cache values before mutable borrow
        let origin_mint = ctx.accounts.vault_state.origin_mint;
        let pool_authority = ctx.accounts.vault_state.pool_authority;
        let bump = ctx.accounts.vault_state.bump;
        
        let vault_state = &mut ctx.accounts.vault_state;
        
        // REENTRANCY GUARD: Check and set lock before any external calls
        require!(!vault_state.locked, VaultError::ReentrancyDetected);
        vault_state.locked = true;
        
        validate_pool_authority(&ctx.accounts.pool_authority, &pool_authority)?;

        // CRITICAL FIX: Explicitly validate vault has sufficient balance before releasing
        require!(
            ctx.accounts.vault_token_account.amount >= amount,
            VaultError::InsufficientBalance
        );

        let seeds = &[
            seeds::VAULT,
            origin_mint.as_ref(),
            &[bump],
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

        // Release lock after successful transfer
        vault_state.locked = false;

        emit!(VaultRelease {
            origin_mint,
            destination: ctx.accounts.destination_token_account.owner,
            amount,
        });
        Ok(())
    }

    // CRITICAL FIX: Removed direct set_pool_authority - replaced with timelock-based system
    // This prevents instant authority changes that could compromise the vault
    
    // NEW: Propose authority change (with timelock)
    pub fn propose_authority_change(
        ctx: Context<ProposeAuthorityChange>,
        new_pool_authority: Pubkey,
    ) -> Result<()> {
        let state = &ctx.accounts.vault_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            state.pool_authority,
            VaultError::UnauthorizedCaller
        );
        require!(
            new_pool_authority != state.pool_authority,
            VaultError::InvalidAuthorityChange
        );
        
        let clock = Clock::get()?;
        let execute_after = clock
            .unix_timestamp
            .checked_add(TIMELOCK_DURATION_SECONDS)
            .ok_or(VaultError::TimelockOverflow)?;
        
        let pending = &mut ctx.accounts.pending_change;
        pending.vault_state = state.key();
        pending.current_authority = state.pool_authority;
        pending.new_authority = new_pool_authority;
        pending.proposed_at = clock.unix_timestamp;
        pending.execute_after = execute_after;
        pending.executed = false;
        pending.canceled = false;
        pending.bump = ctx.bumps.pending_change;
        
        emit!(AuthorityChangeProposed {
            vault_state: state.key(),
            origin_mint: state.origin_mint,
            current_authority: state.pool_authority,
            new_authority: new_pool_authority,
            proposed_at: clock.unix_timestamp,
            execute_after,
        });
        
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
        
        let state = &mut ctx.accounts.vault_state;
        require_keys_eq!(
            pending.vault_state,
            state.key(),
            VaultError::VaultMismatch
        );
        require_keys_eq!(
            pending.current_authority,
            state.pool_authority,
            VaultError::AuthorityMismatch
        );
        
        let old_authority = state.pool_authority;
        state.pool_authority = pending.new_authority;
        pending.executed = true;
        
        emit!(AuthorityChangeExecuted {
            vault_state: state.key(),
            origin_mint: state.origin_mint,
            old_authority,
            new_authority: pending.new_authority,
            executed_at: clock.unix_timestamp,
            executed_by: ctx.accounts.executor.key(),
        });
        
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
    /// CHECK: Anchor verifies ownership when initializing the associated token account externally.
    pub origin_mint: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
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
        close = executor,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
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
        close = authority,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
}

#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub bump: u8,
    pub locked: bool, // Reentrancy guard
}

impl VaultState {
    // SPACE: discriminator (8) + origin_mint (32) + pool_authority (32) + bump (1) + locked (1) + padding (6)
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 6;
}

// CRITICAL FIX: Pending authority change account for timelock system
#[account]
pub struct PendingAuthorityChange {
    pub vault_state: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,
    pub executed: bool,
    pub canceled: bool,
    pub bump: u8,
}

impl PendingAuthorityChange {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 1 + 7;
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
}

#[event]
pub struct AuthorityChangeExecuted {
    pub vault_state: Pubkey,
    pub origin_mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub executed_at: i64,
    pub executed_by: Pubkey,
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

#[error_code]
pub enum VaultError {
    #[msg("E_UNAUTHORIZED_CALLER")]
    UnauthorizedCaller,
    #[msg("E_INVALID_MINT")]
    InvalidMint,
    #[msg("E_INVALID_DEPOSIT_AMOUNT")]
    InvalidDepositAmount,
    #[msg("E_INVALID_RELEASE_AMOUNT")]
    InvalidReleaseAmount,
    #[msg("E_INSUFFICIENT_BALANCE")]
    InsufficientBalance,
    // CRITICAL FIX: Reentrancy protection
    #[msg("E_REENTRANCY_DETECTED")]
    ReentrancyDetected,
    // CRITICAL FIX: Error types for timelock-based authority changes
    #[msg("E_TIMELOCK_OVERFLOW")]
    TimelockOverflow,
    #[msg("E_TIMELOCK_NOT_READY")]
    TimelockNotReady,
    #[msg("E_ALREADY_EXECUTED")]
    AlreadyExecuted,
    #[msg("E_CHANGE_CANCELED")]
    ChangeCanceled,
    #[msg("E_VAULT_MISMATCH")]
    VaultMismatch,
    #[msg("E_AUTHORITY_MISMATCH")]
    AuthorityMismatch,
    #[msg("E_INVALID_AUTHORITY_CHANGE")]
    InvalidAuthorityChange,
    #[msg("E_ALREADY_CANCELED")]
    AlreadyCanceled,
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
