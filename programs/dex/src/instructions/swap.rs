use anchor_lang::prelude::*;
use anchor_spl::token_interface::Transfer;
use std::mem;

use crate::errors::DexError;
use crate::state::DEX_POOL_SEED;
use crate::ztoken_cpi::{parse_ztoken_accounts, invoke_transfer_cpi, TransferArgs, extract_pool_commitment};
use ptf_pool::ID as POOL_PROGRAM_ID;

pub fn swap(
    ctx: Context<crate::Swap>,
    amount_in: u64,
    min_amount_out: u64,
    a_to_b: bool,
    transfer_args_in: TransferArgs,
    transfer_args_out: TransferArgs,
) -> Result<()> {
    // Validate amounts
    require!(amount_in > 0, DexError::InvalidAmount);
    
    // Cache values before mutable borrow
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    let pool_state_key = ctx.accounts.pool_state.key();
    let payer_pubkey = ctx.accounts.payer.key();
    
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Validate pool exists
    require!(
        pool_state.total_lp_supply > 0,
        DexError::PoolNotInitialized
    );
    
    // Validate token mints match
    require_keys_eq!(pool_state.token_a_mint, token_a, DexError::MintMismatch);
    require_keys_eq!(pool_state.token_b_mint, token_b, DexError::MintMismatch);
    
    // Determine swap direction: if a_to_b is true, swap token_a -> token_b, else token_b -> token_a
    // Both tokens are always zTokens
    let (reserve_in, reserve_out, token_in_mint, token_out_mint) = if a_to_b {
        (
            pool_state.get_reserve_a(),
            pool_state.get_reserve_b(),
            token_a,
            token_b,
        )
    } else {
        (
            pool_state.get_reserve_b(),
            pool_state.get_reserve_a(),
            token_b,
            token_a,
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
    
    // Get current private reserve amounts
    let current_private_reserve_a_amount = pool_state.private_reserve_a_amount;
    let current_private_reserve_b_amount = pool_state.private_reserve_b_amount;
    
    // Update protocol fee accumulators (reserves updated after CPIs)
    // LP fee (70% of total_fee) auto-compounds into reserves via CPIs
    // Protocol fee (30% of total_fee) is tracked in accumulator
    if a_to_b {
        // Swapping token_a -> token_b
        pool_state.protocol_fee_accumulator_a = pool_state.protocol_fee_accumulator_a
            .checked_add(protocol_fee)
            .ok_or(DexError::MathOverflow)?;
    } else {
        // Swapping token_b -> token_a
        pool_state.protocol_fee_accumulator_b = pool_state.protocol_fee_accumulator_b
            .checked_add(protocol_fee)
            .ok_or(DexError::MathOverflow)?;
    }
    
    // Store results from zToken CPIs for later pool state updates
    let mut new_private_reserve_a_commitment: Option<[u8; 32]> = None;
    let mut new_private_reserve_a_amount: Option<u64> = None;
    let mut new_private_reserve_b_commitment: Option<[u8; 32]> = None;
    let mut new_private_reserve_b_amount: Option<u64> = None;
    
    // Prepare seeds for PDA signing
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // CRITICAL: Drop mutable borrow BEFORE accessing remaining_accounts
    // This prevents lifetime conflicts with Rust borrow checker
    drop(pool_state);
    
    // ====================================================================
    // ZTOKEN HANDLING: Swap with zToken input (user → pool PDA)
    // ====================================================================
    // Both tokens are always zTokens - use private transfer CPIs
    msg!("[swap] Token in is zToken - invoking private_transfer CPI (user → pool PDA)");
    msg!("[swap] Token in is zToken - invoking private_transfer CPI (user → pool PDA)");
    
    // Determine current private reserve based on swap direction
    let current_private_reserve = if a_to_b {
        current_private_reserve_a_amount
    } else {
        current_private_reserve_b_amount
    };
    
    let remaining_accounts_info: &'static [anchor_lang::prelude::AccountInfo<'static>] = unsafe { mem::transmute(ctx.remaining_accounts) };
    let (commitment, amount_result) = handle_ztoken_swap_input(
        remaining_accounts_info,
        &payer_pubkey,
        &token_in_mint,
        &POOL_PROGRAM_ID,
        transfer_args_in,
        &pool_state_key,
        current_private_reserve,
        amount_in,
        0,
    )?;
    
    // Store commitment results for later pool state update
    if let Some(commitment) = commitment {
        if let Some(amount) = amount_result {
            if a_to_b {
                new_private_reserve_a_commitment = Some(commitment);
                new_private_reserve_a_amount = Some(amount);
            } else {
                new_private_reserve_b_commitment = Some(commitment);
                new_private_reserve_b_amount = Some(amount);
            }
        }
    }
    
    // ====================================================================
    // ZTOKEN HANDLING: Swap with zToken output (pool PDA → user)
    // ====================================================================
    // Both tokens are always zTokens - use private transfer CPIs
    msg!("[swap] Token out is zToken - invoking private_transfer CPI (pool PDA → user)");
    
    // Calculate offset: input uses first 7 accounts, output uses next 7
    let account_offset = 7;
    
    // Determine current private reserve based on swap direction
    let current_private_reserve = if a_to_b {
        current_private_reserve_b_amount
    } else {
        current_private_reserve_a_amount
    };
    
    let (commitment, amount_result) = handle_ztoken_swap_output(
        remaining_accounts_info,
        &payer_pubkey,
        &token_out_mint,
        &POOL_PROGRAM_ID,
        transfer_args_out,
        &pool_state_key,
        &token_a,
        &token_b,
        pool_bump,
        current_private_reserve,
        amount_out,
        account_offset,
    )?;
    
    // Store commitment results for later pool state update
    if let Some(commitment) = commitment {
        if let Some(amount) = amount_result {
            if a_to_b {
                new_private_reserve_b_commitment = Some(commitment);
                new_private_reserve_b_amount = Some(amount);
            } else {
                new_private_reserve_a_commitment = Some(commitment);
                new_private_reserve_a_amount = Some(amount);
            }
        }
    }
    
    // Re-acquire mutable borrow to update private reserve commitments
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Update private reserves if CPIs were executed
    if let Some(commitment) = new_private_reserve_a_commitment {
        if let Some(amount) = new_private_reserve_a_amount {
            pool_state.update_private_reserve_a(commitment, amount);
            msg!("[swap] Updated private reserve A: commitment={:?}, amount={}", commitment, amount);
        }
    }
    
    if let Some(commitment) = new_private_reserve_b_commitment {
        if let Some(amount) = new_private_reserve_b_amount {
            pool_state.update_private_reserve_b(commitment, amount);
            msg!("[swap] Updated private reserve B: commitment={:?}, amount={}", commitment, amount);
        }
    }
    
    Ok(())
}

/// Helper function to handle zToken input transfer for swap (user → pool PDA)
/// Similar to handle_ztoken_liquidity from add_liquidity
fn handle_ztoken_swap_input(
    remaining_accounts: &'static [AccountInfo<'static>],
    payer_pubkey: &Pubkey,
    token_mint: &Pubkey,
    pool_program_id: &Pubkey,
    transfer_args: TransferArgs,
    pool_state_key: &Pubkey,
    current_private_reserve: u64,
    amount: u64,
    account_offset: usize,
) -> Result<(Option<[u8; 32]>, Option<u64>)> {
    let ra = remaining_accounts;

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

    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.pool_state.key(),
        false,
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

    anchor_lang::solana_program::program::invoke(
        &instruction,
        &account_infos,
    )?;

    msg!("[swap] ✓ private_transfer CPI invoked successfully (user → pool PDA)");

    let commitment = extract_pool_commitment(&transfer_args.output_commitments, pool_state_key);
    let amount_result = commitment.map(|_| {
        current_private_reserve
            .checked_add(amount)
            .ok_or(DexError::MathOverflow)
    }).transpose()?;

    Ok((commitment, amount_result))
}

/// Helper function to handle zToken output transfer for swap (pool PDA → user)
/// Similar to handle_ztoken_remove_liquidity
fn handle_ztoken_swap_output(
    remaining_accounts: &'static [AccountInfo<'static>],
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
    let ra = remaining_accounts;

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

    msg!("[swap] ✓ private_transfer CPI invoked successfully (pool PDA → user)");

    // Extract commitment from transfer outputs
    let commitment = extract_pool_commitment(&transfer_args.output_commitments, pool_state_key);
    
    // Calculate new reserve amount (subtract amount sent to user)
    let amount_result = commitment.map(|_| {
        current_private_reserve
            .checked_sub(amount)
            .ok_or(DexError::MathOverflow)
    }).transpose()?;

    Ok((commitment, amount_result))
}

// Removed: No longer needed - DEX only supports zToken → zToken swaps
// The handle_ztoken_swap_shield_output function has been removed

// Account struct is defined in lib.rs at crate root for Anchor macro resolution

