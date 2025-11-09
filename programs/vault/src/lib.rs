use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use ptf_common::seeds;

declare_id!("9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh");

#[program]
pub mod ptf_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, pool_authority: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        state.origin_mint = ctx.accounts.origin_mint.key();
        state.pool_authority = pool_authority;
        state.bump = ctx.bumps.vault_state;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidDepositAmount);

        let vault_state = &ctx.accounts.vault_state;
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
        token::transfer(cpi_ctx, amount)?;

        emit!(VaultDeposit {
            origin_mint: vault_state.origin_mint,
            depositor: ctx.accounts.depositor.key(),
            amount,
        });
        Ok(())
    }

    pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidReleaseAmount);
        let vault_state = &ctx.accounts.vault_state;
        require_keys_eq!(
            ctx.accounts.pool_authority.key(),
            vault_state.pool_authority,
            VaultError::UnauthorizedCaller,
        );

        let seeds = &[
            seeds::VAULT,
            vault_state.origin_mint.as_ref(),
            &[vault_state.bump],
        ];
        let signer = &[&seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        emit!(VaultRelease {
            origin_mint: vault_state.origin_mint,
            destination: ctx.accounts.destination_token_account.owner,
            amount,
        });
        Ok(())
    }

    pub fn set_pool_authority(
        ctx: Context<SetPoolAuthority>,
        new_pool_authority: Pubkey,
    ) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            state.pool_authority,
            VaultError::UnauthorizedCaller
        );
        state.pool_authority = new_pool_authority;
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
    pub vault_token_account: Account<'info, TokenAccount>,
    pub origin_mint: Account<'info, Mint>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,
    /// CHECK: Pool authority must be provided by the caller program.
    pub pool_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetPoolAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
}

#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub bump: u8,
}

impl VaultState {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 7;
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

#[error_code]
pub enum VaultError {
    #[msg("caller not authorized to release funds")]
    UnauthorizedCaller,
    #[msg("vault mint mismatch")]
    InvalidMint,
    #[msg("deposit amount must be positive")]
    InvalidDepositAmount,
    #[msg("release amount must be positive")]
    InvalidReleaseAmount,
}
