use anchor_lang::prelude::*;
use anchor_spl::token_interface::Transfer;

use crate::errors::DexError;
use crate::state::DEX_POOL_SEED;

pub fn collect_fees(ctx: Context<crate::CollectFees>) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Validate token mints match
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    require_keys_eq!(pool_state.token_a_mint, token_a, DexError::MintMismatch);
    require_keys_eq!(pool_state.token_b_mint, token_b, DexError::MintMismatch);
    
    // Cache values before mutable borrow
    let pool_bump = pool_state.bump;
    let protocol_fee_a = pool_state.protocol_fee_accumulator_a;
    let protocol_fee_b = pool_state.protocol_fee_accumulator_b;
    let token_a_is_ztoken = pool_state.token_a_is_ztoken;
    let token_b_is_ztoken = pool_state.token_b_is_ztoken;
    
    // Validate fees exist
    require!(protocol_fee_a > 0 || protocol_fee_b > 0, DexError::InvalidAmount);
    
    // Update accumulators to zero before CPIs
    pool_state.protocol_fee_accumulator_a = 0;
    pool_state.protocol_fee_accumulator_b = 0;
    
    // Drop mutable borrow before CPIs
    drop(pool_state);
    
    // Prepare seeds for PDA signing
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Transfer protocol fees to treasury (for public tokens)
    if protocol_fee_a > 0 && !token_a_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_a_account.to_account_info(),
                    to: ctx.accounts.protocol_token_a_account.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            protocol_fee_a,
        )?;
    }
    // TODO: Handle zToken protocol fee collection
    
    if protocol_fee_b > 0 && !token_b_is_ztoken {
        anchor_spl::token_interface::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_token_b_account.to_account_info(),
                    to: ctx.accounts.protocol_token_b_account.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            protocol_fee_b,
        )?;
    }
    // TODO: Handle zToken protocol fee collection
    
    // Note: LP fees (70%) are auto-compounded into reserves during swaps
    // No separate collection needed - they're already in the reserves
    
    Ok(())
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution

