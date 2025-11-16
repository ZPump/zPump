use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self as token_interface, Mint, TokenAccount, TokenInterface, Transfer,
};
use solana_program::pubkey;

use ptf_common::seeds;

declare_id!("9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh");

const PTF_POOL_PROGRAM_ID: Pubkey = pubkey!("7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh");

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
        #[allow(deprecated)]
        token_interface::transfer(cpi_ctx, amount)?;

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
        validate_pool_authority(&ctx.accounts.pool_authority, &vault_state.pool_authority)?;

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
        #[allow(deprecated)]
        token_interface::transfer(cpi_ctx, amount)?;

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
