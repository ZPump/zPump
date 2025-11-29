use anchor_lang::prelude::*;
use anchor_spl::token_interface::{MintTo, Transfer};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_program;
use spl_associated_token_account_client::{
    address::get_associated_token_address_with_program_id,
    instruction as ata_instruction,
};

use crate::errors::DexError;
use crate::state::DEX_POOL_SEED;

pub fn add_liquidity(
    ctx: Context<crate::AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
    min_lp_tokens: u64,
) -> Result<()> {
    // Validate amounts
    require!(amount_a > 0, DexError::InvalidAmount);
    require!(amount_b > 0, DexError::InvalidAmount);
    
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Validate pool exists and is initialized
    require!(
        pool_state.total_lp_supply > 0,
        DexError::PoolNotInitialized
    );
    
    // Validate token mints match
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    require_keys_eq!(pool_state.token_a_mint, token_a, DexError::MintMismatch);
    require_keys_eq!(pool_state.token_b_mint, token_b, DexError::MintMismatch);
    
    // Get current reserves (public reserves for public tokens)
    let reserve_a = if pool_state.token_a_is_ztoken {
        0 // TODO: Get from private reserve tracking
    } else {
        pool_state.public_reserve_a
    };
    
    let reserve_b = if pool_state.token_b_is_ztoken {
        0 // TODO: Get from private reserve tracking
    } else {
        pool_state.public_reserve_b
    };
    
    require!(reserve_a > 0 && reserve_b > 0, DexError::InsufficientLiquidity);
    
    // Calculate LP tokens to mint based on proportional contribution
    // LP = min((amount_a * total_supply) / reserve_a, (amount_b * total_supply) / reserve_b)
    let total_supply = pool_state.total_lp_supply;
    
    let lp_from_a = (amount_a as u128)
        .checked_mul(total_supply as u128)
        .ok_or(DexError::MathOverflow)?
        .checked_div(reserve_a as u128)
        .ok_or(DexError::MathOverflow)?;
    
    let lp_from_b = (amount_b as u128)
        .checked_mul(total_supply as u128)
        .ok_or(DexError::MathOverflow)?
        .checked_div(reserve_b as u128)
        .ok_or(DexError::MathOverflow)?;
    
    let lp_tokens = lp_from_a.min(lp_from_b) as u64;
    
    // Slippage protection
    require!(lp_tokens >= min_lp_tokens, DexError::SlippageExceeded);
    
    // Transfer tokens to pool reserves (for public tokens)
    if !pool_state.token_a_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_a_account.to_account_info(),
                    to: ctx.accounts.pool_token_a_account.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount_a,
        )?;
        pool_state.public_reserve_a = pool_state.public_reserve_a
            .checked_add(amount_a)
            .ok_or(DexError::MathOverflow)?;
    }
    // ====================================================================
    // ZTOKEN HANDLING: Add liquidity with zToken (token A)
    // ====================================================================
    // For zTokens, adding liquidity requires transferring zTokens from user
    // to the DEX pool PDA via ptf_pool::private_transfer CPI.
    //
    // Requirements:
    // 1. Client must generate proof via ProofClient
    // 2. Client must pass zToken pool accounts via remaining_accounts
    // 3. Client must pass proof data (TransferArgs) as instruction parameters
    // 4. DEX pool PDA signs as recipient authority
    //
    // See create_pool.rs for detailed account requirements.
    // TODO: Implement ptf_pool::private_transfer CPI for token A zToken transfer
    if pool_state.token_a_is_ztoken {
        msg!("[add_liquidity] Token A is zToken - zToken transfer CPI not yet implemented");
        msg!("[add_liquidity] TODO: Implement ptf_pool::private_transfer CPI for token A");
        // TODO: Update private_reserve_a_commitment based on transfer
    }
    
    if !pool_state.token_b_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_b_account.to_account_info(),
                    to: ctx.accounts.pool_token_b_account.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount_b,
        )?;
        pool_state.public_reserve_b = pool_state.public_reserve_b
            .checked_add(amount_b)
            .ok_or(DexError::MathOverflow)?;
    }
    // ====================================================================
    // ZTOKEN HANDLING: Add liquidity with zToken (token B)
    // ====================================================================
    // Similar to token A - see comments above.
    // TODO: Implement ptf_pool::private_transfer CPI for token B zToken transfer
    if pool_state.token_b_is_ztoken {
        msg!("[add_liquidity] Token B is zToken - zToken transfer CPI not yet implemented");
        msg!("[add_liquidity] TODO: Implement ptf_pool::private_transfer CPI for token B");
        // TODO: Update private_reserve_b_commitment based on transfer
    }
    
    // Update total LP supply
    pool_state.total_lp_supply = pool_state.total_lp_supply
        .checked_add(lp_tokens)
        .ok_or(DexError::MathOverflow)?;
    
    // Prepare seeds for PDA signing
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[pool_state.bump],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Verify LP mint is valid before minting
    let lp_mint_info = ctx.accounts.lp_token_mint.to_account_info();
    require!(
        lp_mint_info.owner == &anchor_spl::token::ID || lp_mint_info.owner == &anchor_spl::token_2022::ID,
        DexError::InvalidMintFormat
    );
    require!(
        !lp_mint_info.data_is_empty(),
        DexError::InvalidMintFormat
    );
    msg!("[add_liquidity] LP mint validated: {}, owner: {}", lp_mint_info.key(), lp_mint_info.owner);
    
    // Drop mutable borrow before CPI
    drop(pool_state);
    
    // Verify user LP token account exists and is valid
    let user_lp_account_info = ctx.accounts.user_lp_token_account.to_account_info();
    let account_owner = user_lp_account_info.owner;
    let account_exists = account_owner == &anchor_spl::token::ID 
        || account_owner == &anchor_spl::token_2022::ID;
    let account_has_data = !user_lp_account_info.data_is_empty();
    
    msg!("[add_liquidity] User LP token account check: key={}, owner={}, exists={}, has_data={}", 
        user_lp_account_info.key(), account_owner, account_exists, account_has_data);
    
    // Require that user LP token account exists and is valid
    require!(
        account_exists && account_has_data,
        DexError::InvalidAccount
    );
    
    // Mint LP tokens to user
    msg!("[add_liquidity] Minting {} LP tokens to {}", lp_tokens, user_lp_account_info.key());
    let mint_to_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.lp_token_mint.to_account_info(),
            to: ctx.accounts.user_lp_token_account.to_account_info(),
            authority: ctx.accounts.pool_state.to_account_info(),
        },
        signer_seeds,
    );
    anchor_spl::token_interface::mint_to(mint_to_ctx, lp_tokens)?;
    msg!("[add_liquidity] ✓ Successfully minted {} LP tokens", lp_tokens);
    
    Ok(())
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution

