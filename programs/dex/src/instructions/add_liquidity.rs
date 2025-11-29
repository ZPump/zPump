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
use crate::ztoken_cpi::{parse_ztoken_accounts, invoke_transfer_cpi, TransferArgs, extract_pool_commitment};
use ptf_pool::ID as POOL_PROGRAM_ID;

pub fn add_liquidity(
    ctx: Context<crate::AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
    min_lp_tokens: u64,
    transfer_args_a: Option<TransferArgs>,
    transfer_args_b: Option<TransferArgs>,
) -> Result<()> {
    // Validate amounts
    require!(amount_a > 0, DexError::InvalidAmount);
    require!(amount_b > 0, DexError::InvalidAmount);
    
    // Cache only primitive values (keys, not AccountInfos)
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    let pool_state_key = ctx.accounts.pool_state.key();
    
    // Read pool_state immutably first to cache ALL values we need
    let pool_state_ref = &ctx.accounts.pool_state;
    let token_a_is_ztoken = pool_state_ref.token_a_is_ztoken;
    let token_b_is_ztoken = pool_state_ref.token_b_is_ztoken;
    let current_private_reserve_a_amount = pool_state_ref.private_reserve_a_amount;
    let current_private_reserve_b_amount = pool_state_ref.private_reserve_b_amount;
    
    // Validate pool exists and is initialized
    require!(
        pool_state_ref.total_lp_supply > 0,
        DexError::PoolNotInitialized
    );
    
    // Validate token mints match
    require_keys_eq!(pool_state_ref.token_a_mint, token_a, DexError::MintMismatch);
    require_keys_eq!(pool_state_ref.token_b_mint, token_b, DexError::MintMismatch);
    
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Get current reserves (public or private)
    let reserve_a = pool_state.get_reserve_a();
    let reserve_b = pool_state.get_reserve_b();
    
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
    
    // Cache pool_state values needed after dropping mutable borrow
    let pool_bump = pool_state.bump;
    
    // Transfer tokens to pool reserves (for public tokens only)
    if !token_a_is_ztoken {
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
    
    if !token_b_is_ztoken {
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
    
    // Update total LP supply
    pool_state.total_lp_supply = pool_state.total_lp_supply
        .checked_add(lp_tokens)
        .ok_or(DexError::MathOverflow)?;
    
    // Prepare seeds for PDA signing (cache before dropping)
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Store private reserve commitments to update after CPIs
    let mut new_private_reserve_a_commitment: Option<[u8; 32]> = None;
    let mut new_private_reserve_a_amount: Option<u64> = None;
    let mut new_private_reserve_b_commitment: Option<[u8; 32]> = None;
    let mut new_private_reserve_b_amount: Option<u64> = None;
    
    // CRITICAL: Drop mutable borrow BEFORE accessing remaining_accounts
    // This prevents lifetime conflicts with Rust borrow checker
    drop(pool_state);
    
    // ====================================================================
    // ZTOKEN HANDLING: Add liquidity with zToken (token A)
    // ====================================================================
    // For zTokens, adding liquidity requires transferring zTokens from user
    // to the DEX pool PDA via ptf_pool::private_transfer CPI.
    if token_a_is_ztoken {
        if let Some(transfer_args) = transfer_args_a {
            msg!("[add_liquidity] Token A is zToken - invoking private_transfer CPI (user → pool PDA)");
            
            require!(!ctx.remaining_accounts.is_empty(), DexError::InvalidAccount);
            
            let ztoken_accounts = parse_ztoken_accounts(
                ctx.remaining_accounts,
                &token_a,
                &POOL_PROGRAM_ID,
                false, // is_shield = false (this is a transfer)
            )?;
            
            // Invoke private_transfer CPI (user is sender, pool PDA is recipient)
            // Access AccountInfos directly after dropping pool_state
            invoke_transfer_cpi(
                &ztoken_accounts,
                ctx.remaining_accounts,
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.rent.to_account_info(),
                transfer_args.clone(),
                false, // sender_is_pool_pda = false (user is sender)
                None, // pool_pda_seeds = None (user signs, not pool PDA)
            )?;
            
            // Extract commitment for pool state update
            if let Some(commitment) = extract_pool_commitment(&transfer_args.output_commitments, &pool_state_key) {
                new_private_reserve_a_commitment = Some(commitment);
                new_private_reserve_a_amount = Some(
                    current_private_reserve_a_amount
                        .checked_add(amount_a)
                        .ok_or(DexError::MathOverflow)?
                );
            }
        }
    }
    
    // ====================================================================
    // ZTOKEN HANDLING: Add liquidity with zToken (token B)
    // ====================================================================
    if token_b_is_ztoken {
        if let Some(transfer_args) = transfer_args_b {
            msg!("[add_liquidity] Token B is zToken - invoking private_transfer CPI (user → pool PDA)");
            
            let account_offset = if token_a_is_ztoken { 7 } else { 0 };
            require!(ctx.remaining_accounts.len() > account_offset, DexError::InvalidAccount);
            
            let token_b_accounts = &ctx.remaining_accounts[account_offset..];
            let ztoken_accounts = parse_ztoken_accounts(
                token_b_accounts,
                &token_b,
                &POOL_PROGRAM_ID,
                false, // is_shield = false (this is a transfer)
            )?;
            
            // Invoke private_transfer CPI (user is sender, pool PDA is recipient)
            // Access AccountInfos directly after dropping pool_state
            invoke_transfer_cpi(
                &ztoken_accounts,
                ctx.remaining_accounts,
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &ctx.accounts.rent.to_account_info(),
                transfer_args.clone(),
                false, // sender_is_pool_pda = false (user is sender)
                None, // pool_pda_seeds = None (user signs, not pool PDA)
            )?;
            
            // Extract commitment for pool state update
            if let Some(commitment) = extract_pool_commitment(&transfer_args.output_commitments, &pool_state_key) {
                new_private_reserve_b_commitment = Some(commitment);
                new_private_reserve_b_amount = Some(
                    current_private_reserve_b_amount
                        .checked_add(amount_b)
                        .ok_or(DexError::MathOverflow)?
                );
            }
        }
    }
    
    // Re-acquire mutable borrow to update private reserve commitments
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Update private reserves if CPIs were executed
    if let Some(commitment) = new_private_reserve_a_commitment {
        if let Some(amount) = new_private_reserve_a_amount {
            pool_state.update_private_reserve_a(commitment, amount);
            msg!("[add_liquidity] Updated private reserve A: commitment={:?}, amount={}", commitment, amount);
        }
    }
    
    if let Some(commitment) = new_private_reserve_b_commitment {
        if let Some(amount) = new_private_reserve_b_amount {
            pool_state.update_private_reserve_b(commitment, amount);
            msg!("[add_liquidity] Updated private reserve B: commitment={:?}, amount={}", commitment, amount);
        }
    }
    
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

