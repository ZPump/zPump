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
    transfer_args_a: TransferArgs,
    transfer_args_b: TransferArgs,
) -> Result<()> {
    // Validate amounts
    require!(lp_amount > 0, DexError::InvalidAmount);
    
    // Validate token mints match (before mutable borrow)
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    
    // Cache values before mutable borrow for CPIs
    let pool_state_key = ctx.accounts.pool_state.key();
    let payer_pubkey = ctx.accounts.payer.key();
    
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
    
    // Get current reserves (always private for zTokens)
    let reserve_a = pool_state.get_reserve_a();
    let reserve_b = pool_state.get_reserve_b();
    
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
    
    // Get current private reserve amounts before mutable borrow
    let current_private_reserve_a_amount = pool_state.private_reserve_a_amount;
    let current_private_reserve_b_amount = pool_state.private_reserve_b_amount;
    
    // Prepare seeds for PDA signing (use cached bump)
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Update LP supply (reserves updated after CPIs)
    pool_state.total_lp_supply = pool_state.total_lp_supply
        .checked_sub(lp_amount)
        .ok_or(DexError::MathOverflow)?;
    
    // Store results from zToken CPIs for later pool state updates
    let mut new_private_reserve_a_commitment: Option<[u8; 32]> = None;
    let mut new_private_reserve_a_amount: Option<u64> = None;
    let mut new_private_reserve_b_commitment: Option<[u8; 32]> = None;
    let mut new_private_reserve_b_amount: Option<u64> = None;
    
    // CRITICAL: Drop mutable borrow BEFORE accessing remaining_accounts
    // This prevents lifetime conflicts with Rust borrow checker
    drop(pool_state);
    
    // ====================================================================
    // ZTOKEN HANDLING: Remove liquidity with zToken (token A)
    // ====================================================================
    // Both tokens are always zTokens - use private transfer CPIs
    msg!("[remove_liquidity] Token A is zToken - invoking private_transfer CPI (pool PDA → user)");
    let (commitment_a, amount_a_result) = handle_ztoken_remove_liquidity(
        ctx.remaining_accounts.to_vec(),
        &payer_pubkey,
        &token_a,
        &POOL_PROGRAM_ID,
        transfer_args_a,
        &pool_state_key,
        &token_a,
        &token_b,
        pool_bump,
        current_private_reserve_a_amount,
        amount_a,
        0,
    )?;
    
    // Store commitment results for later pool state update
    if let Some(commitment) = commitment_a {
        if let Some(amount) = amount_a_result {
            new_private_reserve_a_commitment = Some(commitment);
            new_private_reserve_a_amount = Some(amount);
        }
    }
    
    // ====================================================================
    // ZTOKEN HANDLING: Remove liquidity with zToken (token B)
    // ====================================================================
    msg!("[remove_liquidity] Token B is zToken - invoking private_transfer CPI (pool PDA → user)");
    
    // Token A uses first 7 accounts, Token B uses next 7
    let account_offset = 7;
    let (commitment_b, amount_b_result) = handle_ztoken_remove_liquidity(
        ctx.remaining_accounts.to_vec(),
        &payer_pubkey,
        &token_b,
        &POOL_PROGRAM_ID,
        transfer_args_b,
        &pool_state_key,
        &token_a,
        &token_b,
        pool_bump,
        current_private_reserve_b_amount,
        amount_b,
        account_offset,
    )?;
    
    // Store commitment results for later pool state update
    if let Some(commitment) = commitment_b {
        if let Some(amount) = amount_b_result {
            new_private_reserve_b_commitment = Some(commitment);
            new_private_reserve_b_amount = Some(amount);
        }
    }
    
    // Re-acquire mutable borrow to update private reserve commitments
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Update private reserves if CPIs were executed
    if let Some(commitment) = new_private_reserve_a_commitment {
        if let Some(amount) = new_private_reserve_a_amount {
            pool_state.update_private_reserve_a(commitment, amount);
            msg!("[remove_liquidity] Updated private reserve A: commitment={:?}, amount={}", commitment, amount);
        }
    }
    
    if let Some(commitment) = new_private_reserve_b_commitment {
        if let Some(amount) = new_private_reserve_b_amount {
            pool_state.update_private_reserve_b(commitment, amount);
            msg!("[remove_liquidity] Updated private reserve B: commitment={:?}, amount={}", commitment, amount);
        }
    }
    
    // Drop mutable borrow before other CPIs
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
    
    // zToken-only: Transfer is handled via handle_ztoken_remove_liquidity below
    // TODO: Handle zToken transfer via ptf_pool::transfer
    
    Ok(())
}

/// Helper function to handle zToken private_transfer CPI for remove_liquidity
/// 
/// Pool PDA is the sender (signs with seeds), user is the recipient
/// Returns (commitment, new_reserve_amount) for updating pool state
fn handle_ztoken_remove_liquidity<'info>(
    remaining_accounts: Vec<AccountInfo<'info>>,
    payer_pubkey: &Pubkey,
    token_mint: &Pubkey,
    pool_program_id: &Pubkey,
    transfer_args: TransferArgs,
    pool_state_key: &Pubkey,
    token_a_mint: &Pubkey,
    token_b_mint: &Pubkey,
    pool_bump: u8,
    current_private_reserve: u64,
    amount: u64,
    account_offset: usize,
) -> Result<(Option<[u8; 32]>, Option<u64>)> {
    let ra = remaining_accounts.as_slice();

    require!(ra.len() > account_offset, DexError::InvalidAccount);

    let token_accounts_slice = &ra[account_offset..];
    let ztoken_accounts = crate::ztoken_cpi::parse_ztoken_accounts(
        token_accounts_slice,
        token_mint,
        pool_program_id,
        false,
    )?;

    let mut account_metas = Vec::new();
    let mut account_infos: Vec<AccountInfo> = Vec::new();

    // pool_state (PDA, writable, signer) - pool PDA is the sender
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.pool_state.key(),
        true, // Pool PDA signs
    ));
    account_infos.push(ztoken_accounts.pool_state.clone());

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.nullifier_set.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.nullifier_set.clone());

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.commitment_tree.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.commitment_tree.clone());

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.note_ledger.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.note_ledger.clone());

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.mint_mapping.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.mint_mapping.clone());

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.verifier_program.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.verifier_program.clone());

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.verifying_key.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.verifying_key.clone());

    let (payer_account, system_program_account, rent_account) =
        crate::ztoken_cpi::parse_cpi_common_accounts(
            ra,
            payer_pubkey,
        )?;

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        payer_account.key(),
        true,
    ));
    account_infos.push(payer_account);

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        system_program_account.key(),
        false,
    ));
    account_infos.push(system_program_account);

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        rent_account.key(),
        false,
    ));
    account_infos.push(rent_account);

    let mut instruction_data = Vec::new();
    instruction_data.extend_from_slice(&[107, 20, 177, 94, 33, 119, 16, 110]);
    let args_data = transfer_args.try_to_vec()
        .map_err(|_| DexError::InvalidProof)?;
    instruction_data.extend_from_slice(&args_data);

    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: *pool_program_id,
        accounts: account_metas,
        data: instruction_data,
    };

    // Prepare pool PDA seeds for signing (pool PDA is sender)
    let pool_seeds: &[&[u8]] = &[
        crate::state::DEX_POOL_SEED,
        token_a_mint.as_ref(),
        token_b_mint.as_ref(),
        &[pool_bump],
    ];

    // Invoke with pool PDA signing
    anchor_lang::solana_program::program::invoke_signed(
        &instruction,
        &account_infos,
        &[pool_seeds],
    )?;

    msg!("[remove_liquidity] ✓ private_transfer CPI invoked successfully (pool PDA → user)");

    // Extract commitment from transfer outputs
    // Note: The pool PDA is the sender, so we need to find the output that remains with the pool
    // (or subtract the output that goes to the user)
    // For simplicity, we'll extract user's output commitment and calculate pool's remaining
    let commitment = extract_pool_commitment(&transfer_args.output_commitments, pool_state_key);
    
    // Calculate new reserve amount (subtract amount removed)
    let amount_result = commitment.map(|_| {
        current_private_reserve
            .checked_sub(amount)
            .ok_or(DexError::MathOverflow)
    }).transpose()?;

    Ok((commitment, amount_result))
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution

