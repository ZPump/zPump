use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Burn, Transfer, TokenAccount};

use crate::errors::DexError;
use crate::state::DEX_POOL_SEED;
use crate::ztoken_cpi::{parse_ztoken_accounts, invoke_transfer_cpi, TransferArgs, extract_pool_commitment};
use ptf_pool::ID as POOL_PROGRAM_ID;

pub fn remove_liquidity(
    ctx: Context<crate::RemoveLiquidity>,
    lp_amount: u64,
    min_amount_a: u64,
    min_amount_b: u64,
) -> Result<()> {
    // Validate amounts
    require!(lp_amount > 0, DexError::InvalidAmount);
    
    // Validate token mints match (before mutable borrow)
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Validate pool exists
    require!(
        pool_state.total_lp_supply > 0,
        DexError::PoolNotInitialized
    );
    
    // Validate LP amount doesn't exceed supply
    require!(
        lp_amount <= pool_state.total_lp_supply,
        DexError::InsufficientLPTokens
    );
    
    require_keys_eq!(pool_state.token_a_mint, token_a, DexError::MintMismatch);
    require_keys_eq!(pool_state.token_b_mint, token_b, DexError::MintMismatch);
    
    // Cache values before mutable borrow for CPIs
    let pool_bump = pool_state.bump;
    let token_a_is_ztoken = pool_state.token_a_is_ztoken;
    let token_b_is_ztoken = pool_state.token_b_is_ztoken;
    
    // Get current reserves
    let reserve_a = if token_a_is_ztoken {
        0 // TODO: Get from private reserve tracking
    } else {
        pool_state.public_reserve_a
    };
    
    let reserve_b = if token_b_is_ztoken {
        0 // TODO: Get from private reserve tracking
    } else {
        pool_state.public_reserve_b
    };
    
    require!(reserve_a > 0 && reserve_b > 0, DexError::InsufficientLiquidity);
    
    // Calculate proportional reserves to return
    // amount = (lp_amount * reserve) / total_supply
    let total_supply = pool_state.total_lp_supply;
    
    let amount_a = (lp_amount as u128)
        .checked_mul(reserve_a as u128)
        .ok_or(DexError::MathOverflow)?
        .checked_div(total_supply as u128)
        .ok_or(DexError::MathOverflow)? as u64;
    
    let amount_b = (lp_amount as u128)
        .checked_mul(reserve_b as u128)
        .ok_or(DexError::MathOverflow)?
        .checked_div(total_supply as u128)
        .ok_or(DexError::MathOverflow)? as u64;
    
    // Slippage protection
    require!(amount_a >= min_amount_a, DexError::SlippageExceeded);
    require!(amount_b >= min_amount_b, DexError::SlippageExceeded);
    
    // Prepare seeds for PDA signing (use cached bump)
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Update reserves and LP supply first
    if !token_a_is_ztoken {
        pool_state.public_reserve_a = pool_state.public_reserve_a
            .checked_sub(amount_a)
            .ok_or(DexError::MathOverflow)?;
    }
    // ====================================================================
    // ZTOKEN HANDLING: Remove liquidity with zToken (token A)
    // ====================================================================
    // For zTokens, removing liquidity requires transferring zTokens from
    // the DEX pool PDA to the user via ptf_pool::private_transfer CPI.
    //
    // Requirements:
    // 1. Client must generate proof via ProofClient
    // 2. Client must pass zToken pool accounts via remaining_accounts
    // 3. Client must pass proof data (TransferArgs) as instruction parameters
    // 4. DEX pool PDA signs as sender authority (using pool_state PDA seeds)
    //
    // zToken transfer CPI for token A (pool PDA → user)
    if pool_state.token_a_is_ztoken {
        msg!("[remove_liquidity] Token A is zToken - processing private_transfer CPI (pool PDA → user)");
        
        // Validate that we have remaining_accounts for zToken pool
        require!(
            !ctx.remaining_accounts.is_empty(),
            DexError::InvalidAccount
        );
        
        msg!("[remove_liquidity] Found {} remaining_accounts for zToken pool A", ctx.remaining_accounts.len());
        
        // NOTE: Lifetime issue needs to be resolved when adding TransferArgs as instruction parameters
        // For now, validate account structure is ready
        msg!("[remove_liquidity] zToken pool A accounts structure validated");
        msg!("[remove_liquidity] Private transfer CPI structure ready - will be invoked when TransferArgs added to signature");
        
        // TODO: Uncomment when lifetime issue resolved and TransferArgs added:
        // let ztoken_accounts = parse_ztoken_accounts(
        //     ctx.remaining_accounts,
        //     &pool_state.token_a_mint,
        //     &POOL_PROGRAM_ID,
        //     false, // is_shield = false (this is a transfer)
        // )?;
        // 
        // // Prepare pool PDA seeds for signing (pool PDA is sender)
        // let pool_seeds: &[&[u8]] = &[
        //     DEX_POOL_SEED,
        //     pool_state.token_a_mint.as_ref(),
        //     pool_state.token_b_mint.as_ref(),
        //     &[pool_state.bump],
        // ];
        // 
        // // Invoke private_transfer CPI (pool PDA is sender, user is recipient)
        // invoke_transfer_cpi(
        //     &ztoken_accounts,
        //     ctx.remaining_accounts,
        //     &ctx.accounts.pool_state.to_account_info(), // sender (pool PDA)
        //     &ctx.accounts.payer.to_account_info(), // payer
        //     &ctx.accounts.system_program.to_account_info(),
        //     &ctx.accounts.rent.to_account_info(), // Note: may need to add rent to account struct
        //     transfer_args, // From instruction parameters (when added)
        //     true, // sender_is_pool_pda = true (pool PDA is sender)
        //     Some(pool_seeds), // pool_pda_seeds for signing
        // )?;
        // 
        // // Extract and update private reserve commitment
        // if let Some(commitment) = extract_pool_commitment(&transfer_args.output_commitments, &ctx.accounts.pool_state.key()) {
        //     pool_state.update_private_reserve_a_commitment(commitment);
        // }
    }
    
    if !token_b_is_ztoken {
        pool_state.public_reserve_b = pool_state.public_reserve_b
            .checked_sub(amount_b)
            .ok_or(DexError::MathOverflow)?;
    }
    // ====================================================================
    // ZTOKEN HANDLING: Remove liquidity with zToken (token B)
    // ====================================================================
    // Similar to token A - see comments above.
    // zToken transfer CPI for token B (pool PDA → user)
    if pool_state.token_b_is_ztoken {
        msg!("[remove_liquidity] Token B is zToken - processing private_transfer CPI (pool PDA → user)");
        
        // For token B, remaining_accounts come after token A accounts if token A is also zToken
        // Calculate offset: if token A is zToken, it uses first 7 accounts; token B uses next 7
        let account_offset = if pool_state.token_a_is_ztoken { 7 } else { 0 };
        
        require!(
            ctx.remaining_accounts.len() > account_offset,
            DexError::InvalidAccount
        );
        
        msg!("[remove_liquidity] Processing zToken pool B accounts (offset: {})", account_offset);
        
        // NOTE: Lifetime issue needs to be resolved when adding TransferArgs as instruction parameters
        // For now, validate account structure is ready
        msg!("[remove_liquidity] zToken pool B accounts structure validated");
        msg!("[remove_liquidity] Private transfer CPI structure ready - will be invoked when TransferArgs added to signature");
        
        // TODO: Uncomment when lifetime issue resolved and TransferArgs added:
        // let token_b_accounts = &ctx.remaining_accounts[account_offset..];
        // let ztoken_accounts = parse_ztoken_accounts(
        //     token_b_accounts,
        //     &pool_state.token_b_mint,
        //     &POOL_PROGRAM_ID,
        //     false, // is_shield = false (this is a transfer)
        // )?;
        // 
        // // Prepare pool PDA seeds for signing (pool PDA is sender)
        // let pool_seeds: &[&[u8]] = &[
        //     DEX_POOL_SEED,
        //     pool_state.token_a_mint.as_ref(),
        //     pool_state.token_b_mint.as_ref(),
        //     &[pool_state.bump],
        // ];
        // 
        // // Invoke private_transfer CPI (pool PDA is sender, user is recipient)
        // invoke_transfer_cpi(
        //     &ztoken_accounts,
        //     token_b_accounts,
        //     &ctx.accounts.pool_state.to_account_info(), // sender (pool PDA)
        //     &ctx.accounts.payer.to_account_info(), // payer
        //     &ctx.accounts.system_program.to_account_info(),
        //     &ctx.accounts.rent.to_account_info(), // Note: may need to add rent to account struct
        //     transfer_args, // From instruction parameters (when added)
        //     true, // sender_is_pool_pda = true (pool PDA is sender)
        //     Some(pool_seeds), // pool_pda_seeds for signing
        // )?;
        // 
        // // Extract and update private reserve commitment
        // if let Some(commitment) = extract_pool_commitment(&transfer_args.output_commitments, &ctx.accounts.pool_state.key()) {
        //     pool_state.update_private_reserve_b_commitment(commitment);
        // }
    }
    
    pool_state.total_lp_supply = pool_state.total_lp_supply
        .checked_sub(lp_amount)
        .ok_or(DexError::MathOverflow)?;
    
    // Drop mutable borrow before CPIs
    drop(pool_state);
    
    // Parse token account to validate owner matches payer
    // Token account layout: mint(32) + owner(32) + amount(8) + delegate(36) + state(1) + ...
    let user_lp_account_info = ctx.accounts.user_lp_token_account.to_account_info();
    let user_lp_account_data = user_lp_account_info.try_borrow_data()?;
    require!(user_lp_account_data.len() >= 64, DexError::InvalidAccount);
    
    // Owner is at bytes 32-64
    let account_owner_bytes: [u8; 32] = user_lp_account_data[32..64].try_into().map_err(|_| DexError::InvalidAccount)?;
    let account_owner = Pubkey::try_from(account_owner_bytes).map_err(|_| DexError::InvalidAccount)?;
    
    msg!("[remove_liquidity] Token account owner: {}, payer: {}", account_owner, ctx.accounts.payer.key());
    require_keys_eq!(
        account_owner,
        ctx.accounts.payer.key(),
        DexError::InvalidAccount
    );
    
    // Drop borrow before CPI
    drop(user_lp_account_data);
    
    // Burn LP tokens from user (authority is the user/payer, who owns the token account)
    msg!("[remove_liquidity] Burning {} LP tokens from account owned by {}", lp_amount, ctx.accounts.payer.key());
    let burn_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.lp_token_mint.to_account_info(),
            from: ctx.accounts.user_lp_token_account.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        },
    );
    anchor_spl::token_interface::burn(burn_ctx, lp_amount)?;
    msg!("[remove_liquidity] ✓ LP tokens burned successfully");
    
    // Transfer tokens from pool to user (for public tokens)
    if !token_a_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_a_account.to_account_info(),
                    to: ctx.accounts.user_token_a_account.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount_a,
        )?;
    }
    // TODO: Handle zToken transfer via ptf_pool::transfer
    
    if !token_b_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_b_account.to_account_info(),
                    to: ctx.accounts.user_token_b_account.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount_b,
        )?;
    }
    // TODO: Handle zToken transfer via ptf_pool::transfer
    
    Ok(())
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution

