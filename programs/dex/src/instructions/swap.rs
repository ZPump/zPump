use anchor_lang::prelude::*;
use anchor_spl::token_interface::Transfer;

use crate::errors::DexError;
use crate::state::DEX_POOL_SEED;

pub fn swap(
    ctx: Context<crate::Swap>,
    amount_in: u64,
    min_amount_out: u64,
    a_to_b: bool,
) -> Result<()> {
    // Validate amounts
    require!(amount_in > 0, DexError::InvalidAmount);
    
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Validate pool exists
    require!(
        pool_state.total_lp_supply > 0,
        DexError::PoolNotInitialized
    );
    
    // Validate token mints match
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    require_keys_eq!(pool_state.token_a_mint, token_a, DexError::MintMismatch);
    require_keys_eq!(pool_state.token_b_mint, token_b, DexError::MintMismatch);
    
    // Determine swap direction: if a_to_b is true, swap token_a -> token_b, else token_b -> token_a
    let (token_in_is_ztoken, token_out_is_ztoken, reserve_in, reserve_out) = if a_to_b {
        (
            pool_state.token_a_is_ztoken,
            pool_state.token_b_is_ztoken,
            if pool_state.token_a_is_ztoken {
                0 // TODO: Get from private reserve tracking
            } else {
                pool_state.public_reserve_a
            },
            if pool_state.token_b_is_ztoken {
                0 // TODO: Get from private reserve tracking
            } else {
                pool_state.public_reserve_b
            },
        )
    } else {
        (
            pool_state.token_b_is_ztoken,
            pool_state.token_a_is_ztoken,
            if pool_state.token_b_is_ztoken {
                0 // TODO: Get from private reserve tracking
            } else {
                pool_state.public_reserve_b
            },
            if pool_state.token_a_is_ztoken {
                0 // TODO: Get from private reserve tracking
            } else {
                pool_state.public_reserve_a
            },
        )
    };
    
    require!(reserve_in > 0 && reserve_out > 0, DexError::InsufficientLiquidity);
    
    // Constant product AMM formula with fees:
    // output = (amount_in * reserve_out * (10000 - fee_bps)) / ((reserve_in * 10000) + (amount_in * (10000 - fee_bps)))
    // This formula applies fee to amount_in before adding to reserves
    const FEE_BPS: u64 = 5; // 5 basis points = 0.05%
    const BPS_DENOMINATOR: u64 = 10_000;
    
    // Calculate output amount with fee
    let amount_in_with_fee = (amount_in as u128)
        .checked_mul((BPS_DENOMINATOR - FEE_BPS) as u128)
        .ok_or(DexError::MathOverflow)?;
    
    let numerator = amount_in_with_fee
        .checked_mul(reserve_out as u128)
        .ok_or(DexError::MathOverflow)?;
    
    let denominator = (reserve_in as u128)
        .checked_mul(BPS_DENOMINATOR as u128)
        .ok_or(DexError::MathOverflow)?
        .checked_add(amount_in_with_fee)
        .ok_or(DexError::MathOverflow)?;
    
    let amount_out = numerator
        .checked_div(denominator)
        .ok_or(DexError::MathOverflow)? as u64;
    
    // Slippage protection
    require!(amount_out >= min_amount_out, DexError::SlippageExceeded);
    
    // Calculate total fees (5 bps of amount_in)
    let total_fee = (amount_in as u128)
        .checked_mul(FEE_BPS as u128)
        .ok_or(DexError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(DexError::MathOverflow)? as u64;
    
    // Split fees: 30% protocol, 70% LP (auto-compound into reserves)
    let protocol_fee = (total_fee as u128)
        .checked_mul(30u128)
        .ok_or(DexError::MathOverflow)?
        .checked_div(100u128)
        .ok_or(DexError::MathOverflow)? as u64;
    
    let lp_fee = total_fee
        .checked_sub(protocol_fee)
        .ok_or(DexError::MathOverflow)?;
    
    // Cache values before mutable borrow
    let pool_bump = pool_state.bump;
    
    // Update reserves based on swap direction (for public tokens)
    // Reserve_in increases by (amount_in - total_fee), reserve_out decreases by amount_out
    // LP fee (70% of total_fee) auto-compounds into reserve_in
    // Protocol fee (30% of total_fee) is tracked in accumulator
    let amount_in_after_fee = amount_in
        .checked_sub(total_fee)
        .ok_or(DexError::MathOverflow)?;
    
    if a_to_b {
        // Swapping token_a -> token_b
        if !pool_state.token_a_is_ztoken {
            pool_state.public_reserve_a = pool_state.public_reserve_a
                .checked_add(amount_in_after_fee)
                .ok_or(DexError::MathOverflow)?;
            pool_state.protocol_fee_accumulator_a = pool_state.protocol_fee_accumulator_a
                .checked_add(protocol_fee)
                .ok_or(DexError::MathOverflow)?;
        }
        if !pool_state.token_b_is_ztoken {
            pool_state.public_reserve_b = pool_state.public_reserve_b
                .checked_sub(amount_out)
                .ok_or(DexError::MathOverflow)?;
        }
    } else {
        // Swapping token_b -> token_a
        if !pool_state.token_b_is_ztoken {
            pool_state.public_reserve_b = pool_state.public_reserve_b
                .checked_add(amount_in_after_fee)
                .ok_or(DexError::MathOverflow)?;
            pool_state.protocol_fee_accumulator_b = pool_state.protocol_fee_accumulator_b
                .checked_add(protocol_fee)
                .ok_or(DexError::MathOverflow)?;
        }
        if !pool_state.token_a_is_ztoken {
            pool_state.public_reserve_a = pool_state.public_reserve_a
                .checked_sub(amount_out)
                .ok_or(DexError::MathOverflow)?;
        }
    }
    // TODO: Handle zToken private reserve updates
    
    // Prepare seeds for PDA signing
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Drop mutable borrow before CPIs
    drop(pool_state);
    
    // Transfer input token from user to pool (for public tokens)
    if !token_in_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_in_account.to_account_info(),
                    to: ctx.accounts.pool_token_in_account.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount_in,
        )?;
    }
    // ====================================================================
    // ZTOKEN HANDLING: Swap with zToken input
    // ====================================================================
    // For zToken inputs, we need to transfer zTokens from user to pool PDA.
    // This uses ptf_pool::private_transfer CPI.
    //
    // Requirements:
    // 1. Client generates proof via ProofClient
    // 2. Client passes zToken pool accounts via remaining_accounts
    // 3. Client passes proof data (TransferArgs) as instruction parameters
    //
    // TODO: Implement ptf_pool::private_transfer CPI for zToken input
    if token_in_is_ztoken {
        msg!("[swap] Token in is zToken - zToken transfer CPI not yet implemented");
        msg!("[swap] TODO: Implement ptf_pool::private_transfer CPI for zToken input");
        // TODO: Update private reserve commitment based on transfer
    }
    
    // Transfer output token from pool to user (for public tokens)
    if !token_out_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_out_account.to_account_info(),
                    to: ctx.accounts.user_token_out_account.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount_out,
        )?;
    }
    // ====================================================================
    // ZTOKEN HANDLING: Swap with zToken output
    // ====================================================================
    // For zToken outputs, there are two scenarios:
    // 
    // 1. Public → zToken: Shield public tokens to create zTokens for user
    //    - Uses ptf_pool::shield CPI
    //    - Pool receives public tokens, user receives zTokens
    //
    // 2. zToken → zToken: Private transfer from pool PDA to user
    //    - Uses ptf_pool::private_transfer CPI
    //    - Pool PDA signs as sender (using pool_state PDA seeds)
    //
    // Requirements:
    // 1. Client generates proof via ProofClient
    // 2. Client passes zToken pool accounts via remaining_accounts
    // 3. Client passes proof data as instruction parameters
    //
    // TODO: Implement ptf_pool::shield or private_transfer CPI for zToken output
    if token_out_is_ztoken {
        msg!("[swap] Token out is zToken - zToken output CPI not yet implemented");
        if !token_in_is_ztoken {
            msg!("[swap] TODO: Implement ptf_pool::shield CPI for Public → zToken swap");
        } else {
            msg!("[swap] TODO: Implement ptf_pool::private_transfer CPI for zToken → zToken swap");
        }
        // TODO: Update private reserve commitment based on output
    }
    
    Ok(())
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution

