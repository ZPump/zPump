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
    let protocol_fee_a = pool_state.protocol_fee_accumulator_a;
    let protocol_fee_b = pool_state.protocol_fee_accumulator_b;
    
    // Validate fees exist
    require!(protocol_fee_a > 0 || protocol_fee_b > 0, DexError::InvalidAmount);
    
    // Update accumulators to zero
    pool_state.protocol_fee_accumulator_a = 0;
    pool_state.protocol_fee_accumulator_b = 0;
    
    // TODO: Handle zToken protocol fee collection via private transfers
    // For now, protocol fees are tracked but not collected from private reserves
    // This requires implementing private transfer CPIs to move fees to protocol treasury
    
    // Note: LP fees (70%) are auto-compounded into reserves during swaps
    // No separate collection needed - they're already in the reserves
    
    Ok(())
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution

