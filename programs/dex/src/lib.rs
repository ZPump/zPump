use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod ztoken;
pub mod ztoken_cpi;

pub use errors::DexError;
pub use state::{PoolState, DEX_POOL_SEED};
pub use ztoken_cpi::{ShieldArgs, TransferArgs, BatchTransferArgs, ZTokenPoolAccounts, parse_ztoken_accounts, parse_cpi_common_accounts, invoke_shield_cpi, invoke_transfer_cpi, invoke_transfer_cpi_with_accounts, invoke_transfer_for_add_liquidity_ctx, invoke_batch_transfer_for_add_liquidity};

declare_id!("2hktsrLk3f6EN7vHR3cYgoTHXJE9Hw4HsU5MRgXtAPZ8");

#[program]
pub mod ptf_dex {
    use super::*;

    pub fn create_pool(
        ctx: Context<CreatePool>,
        initial_amount_a: u64,
        initial_amount_b: u64,
        shield_args_a: ShieldArgs,
        shield_args_b: ShieldArgs,
    ) -> Result<()> {
        instructions::create_pool::create_pool(
            ctx,
            initial_amount_a,
            initial_amount_b,
            shield_args_a,
            shield_args_b,
        )
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp_tokens: u64,
        batch_transfer_args: ztoken_cpi::BatchTransferArgs,
    ) -> Result<()> {
        instructions::add_liquidity::add_liquidity(
            ctx,
            amount_a,
            amount_b,
            min_lp_tokens,
            batch_transfer_args,
        )
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_amount_a: u64,
        min_amount_b: u64,
        transfer_args_a: TransferArgs,
        transfer_args_b: TransferArgs,
    ) -> Result<()> {
        instructions::remove_liquidity::remove_liquidity(
            ctx,
            lp_amount,
            min_amount_a,
            min_amount_b,
            transfer_args_a,
            transfer_args_b,
        )
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_amount_out: u64,
        a_to_b: bool,
        transfer_args_in: TransferArgs,
        transfer_args_out: TransferArgs,
    ) -> Result<()> {
        instructions::swap::swap(
            ctx,
            amount_in,
            min_amount_out,
            a_to_b,
            transfer_args_in,
            transfer_args_out,
        )
    }

    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        instructions::collect_fees::collect_fees(ctx)
    }
}

// Account structs must be defined at crate root for Anchor macro resolution
use anchor_spl::token_interface::TokenInterface;

#[derive(Accounts)]
#[allow(non_snake_case)]
pub struct CreatePool<'info> {
    /// CHECK: Validated to be < token_b_mint in instruction
    pub token_a_mint: AccountInfo<'info>,
    
    /// CHECK: Validated to be > token_a_mint in instruction
    pub token_b_mint: AccountInfo<'info>,
    
    #[account(
        init,
        payer = payer,
        space = PoolState::LEN,
        seeds = [DEX_POOL_SEED, token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump,
    )]
    pub pool_state: Account<'info, PoolState>,
    
    /// CHECK: Will be initialized manually in instruction
    #[account(mut)]
    pub lp_token_mint: UncheckedAccount<'info>,
    
    /// CHECK: User's LP token account (will be created if needed via CPI)
    #[account(mut)]
    pub user_lp_token_account: AccountInfo<'info>,
    
    /// CHECK: User's token A account (required if token_a is public)
    #[account(mut)]
    pub user_token_a_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token A reserve account (will be created if needed, required if token_a is public)
    #[account(mut)]
    pub pool_token_a_account: AccountInfo<'info>,
    
    /// CHECK: User's token B account (required if token_b is public)
    #[account(mut)]
    pub user_token_b_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token B reserve account (will be created if needed, required if token_b is public)
    #[account(mut)]
    pub pool_token_b_account: AccountInfo<'info>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Associated token program for creating ATAs
    pub associated_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[allow(non_snake_case)]
pub struct AddLiquidity<'info> {
    #[account(
        mut,
        seeds = [DEX_POOL_SEED, token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,
    
    /// CHECK: Validated in instruction
    pub token_a_mint: AccountInfo<'info>,
    
    /// CHECK: Validated in instruction
    pub token_b_mint: AccountInfo<'info>,
    
    /// CHECK: LP token mint
    #[account(mut)]
    pub lp_token_mint: UncheckedAccount<'info>,
    
    /// CHECK: User's LP token account
    #[account(mut)]
    pub user_lp_token_account: AccountInfo<'info>,
    
    /// CHECK: User's token A account
    #[account(mut)]
    pub user_token_a_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token A reserve account
    #[account(mut)]
    pub pool_token_a_account: AccountInfo<'info>,
    
    /// CHECK: User's token B account
    #[account(mut)]
    pub user_token_b_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token B reserve account
    #[account(mut)]
    pub pool_token_b_account: AccountInfo<'info>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Associated token program for creating LP token account if needed
    pub associated_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[allow(non_snake_case)]
pub struct RemoveLiquidity<'info> {
    #[account(
        mut,
        seeds = [DEX_POOL_SEED, token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,
    
    /// CHECK: Validated in instruction
    pub token_a_mint: AccountInfo<'info>,
    
    /// CHECK: Validated in instruction
    pub token_b_mint: AccountInfo<'info>,
    
    /// CHECK: LP token mint
    #[account(mut)]
    pub lp_token_mint: UncheckedAccount<'info>,
    
    /// CHECK: User's LP token account
    #[account(mut)]
    pub user_lp_token_account: AccountInfo<'info>,
    
    /// CHECK: User's token A account (will receive output)
    #[account(mut)]
    pub user_token_a_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token A reserve account
    #[account(mut)]
    pub pool_token_a_account: AccountInfo<'info>,
    
    /// CHECK: User's token B account (will receive output)
    #[account(mut)]
    pub user_token_b_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token B reserve account
    #[account(mut)]
    pub pool_token_b_account: AccountInfo<'info>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[allow(non_snake_case)]
pub struct Swap<'info> {
    #[account(
        mut,
        seeds = [DEX_POOL_SEED, token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,
    
    /// CHECK: Validated in instruction
    pub token_a_mint: AccountInfo<'info>,
    
    /// CHECK: Validated in instruction
    pub token_b_mint: AccountInfo<'info>,
    
    /// CHECK: User's input token account (token_in)
    #[account(mut)]
    pub user_token_in_account: AccountInfo<'info>,
    
    /// CHECK: Pool's input token reserve account
    #[account(mut)]
    pub pool_token_in_account: AccountInfo<'info>,
    
    /// CHECK: User's output token account (token_out)
    #[account(mut)]
    pub user_token_out_account: AccountInfo<'info>,
    
    /// CHECK: Pool's output token reserve account
    #[account(mut)]
    pub pool_token_out_account: AccountInfo<'info>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[allow(non_snake_case)]
pub struct CollectFees<'info> {
    #[account(
        mut,
        seeds = [DEX_POOL_SEED, token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,
    
    /// CHECK: Validated in instruction
    pub token_a_mint: AccountInfo<'info>,
    
    /// CHECK: Validated in instruction
    pub token_b_mint: AccountInfo<'info>,
    
    /// CHECK: Protocol treasury token A account
    #[account(mut)]
    pub protocol_token_a_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token A reserve account
    #[account(mut)]
    pub pool_token_a_account: AccountInfo<'info>,
    
    /// CHECK: Protocol treasury token B account
    #[account(mut)]
    pub protocol_token_b_account: AccountInfo<'info>,
    
    /// CHECK: Pool's token B reserve account
    #[account(mut)]
    pub pool_token_b_account: AccountInfo<'info>,
    
    /// CHECK: Protocol authority (signer)
    pub protocol_authority: Signer<'info>,
    
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

