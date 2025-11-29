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
use crate::ztoken_cpi::{TransferArgs, extract_pool_commitment};
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
    let payer_pubkey = ctx.accounts.payer.key(); // Cache for parsing from remaining_accounts
    
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
    // SOLUTION 1: All accounts (zToken + payer/system/rent) come from remaining_accounts
    // This ensures unified lifetime scope
    if token_a_is_ztoken {
        if let Some(transfer_args) = transfer_args_a {
            msg!("[add_liquidity] Token A is zToken - invoking private_transfer CPI (user → pool PDA)");
            
            require!(!ctx.remaining_accounts.is_empty(), DexError::InvalidAccount);
            
            // SOLUTION 1: Parse zToken accounts from remaining_accounts
            // All AccountInfos share the same lifetime scope from remaining_accounts
            let ztoken_accounts = crate::ztoken_cpi::parse_ztoken_accounts(
                ctx.remaining_accounts,
                &token_a,
                &POOL_PROGRAM_ID,
                false,
            )?;
            
            // Build instruction completely inline - access all AccountInfos in same scope
            let mut account_metas = Vec::new();
            let mut account_infos: Vec<AccountInfo> = Vec::new();
            
            // Add parsed zToken accounts
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
            
            // SOLUTION 1: Get payer, system_program, rent from remaining_accounts
            // This ensures all AccountInfos have the same lifetime scope from remaining_accounts
            let (payer_account, system_program_account, rent_account) = 
                crate::ztoken_cpi::parse_cpi_common_accounts(
                    ctx.remaining_accounts,
                    &payer_pubkey, // Use cached pubkey (no ctx.accounts access needed)
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
            
            // Build instruction data
            let mut instruction_data = Vec::new();
            instruction_data.extend_from_slice(&[107, 20, 177, 94, 33, 119, 16, 110]); // discriminator
            let args_data = transfer_args.try_to_vec()
                .map_err(|_| DexError::InvalidProof)?;
            instruction_data.extend_from_slice(&args_data);
            
            // Construct and invoke - all AccountInfos in same Vec
            let instruction = anchor_lang::solana_program::instruction::Instruction {
                program_id: POOL_PROGRAM_ID,
                accounts: account_metas,
                data: instruction_data,
            };
            
            anchor_lang::solana_program::program::invoke(
                &instruction,
                &account_infos,
            )?;
            
            msg!("[add_liquidity] ✓ Token A private_transfer CPI invoked successfully");
            
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
            
            // SOLUTION 1: Inline CPI construction for token B (same approach as token A)
            // Parse zToken accounts for token B (with offset if token A is also zToken)
            let token_b_accounts_slice = &ctx.remaining_accounts[account_offset..];
            let ztoken_accounts_b = crate::ztoken_cpi::parse_ztoken_accounts(
                token_b_accounts_slice,
                &token_b,
                &POOL_PROGRAM_ID,
                false,
            )?;
            
            // Build instruction inline - all AccountInfos from remaining_accounts
            let mut account_metas_b = Vec::new();
            let mut account_infos_b: Vec<AccountInfo> = Vec::new();
            
            // Add parsed zToken accounts for token B
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new(
                ztoken_accounts_b.pool_state.key(),
                false,
            ));
            account_infos_b.push(ztoken_accounts_b.pool_state.clone());
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new(
                ztoken_accounts_b.nullifier_set.key(),
                false,
            ));
            account_infos_b.push(ztoken_accounts_b.nullifier_set.clone());
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new(
                ztoken_accounts_b.commitment_tree.key(),
                false,
            ));
            account_infos_b.push(ztoken_accounts_b.commitment_tree.clone());
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new(
                ztoken_accounts_b.note_ledger.key(),
                false,
            ));
            account_infos_b.push(ztoken_accounts_b.note_ledger.clone());
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ztoken_accounts_b.mint_mapping.key(),
                false,
            ));
            account_infos_b.push(ztoken_accounts_b.mint_mapping.clone());
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ztoken_accounts_b.verifier_program.key(),
                false,
            ));
            account_infos_b.push(ztoken_accounts_b.verifier_program.clone());
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ztoken_accounts_b.verifying_key.key(),
                false,
            ));
            account_infos_b.push(ztoken_accounts_b.verifying_key.clone());
            
            // SOLUTION 1: Get common accounts from remaining_accounts (same lifetime scope)
            let (payer_account_b, system_program_account_b, rent_account_b) = 
                crate::ztoken_cpi::parse_cpi_common_accounts(
                    ctx.remaining_accounts, // Full slice to get accounts at end
                    &payer_pubkey,
                )?;
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new(
                payer_account_b.key(),
                true,
            ));
            account_infos_b.push(payer_account_b);
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                system_program_account_b.key(),
                false,
            ));
            account_infos_b.push(system_program_account_b);
            
            account_metas_b.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                rent_account_b.key(),
                false,
            ));
            account_infos_b.push(rent_account_b);
            
            // Build instruction data
            let mut instruction_data_b = Vec::new();
            instruction_data_b.extend_from_slice(&[107, 20, 177, 94, 33, 119, 16, 110]); // discriminator
            let args_data_b = transfer_args.try_to_vec()
                .map_err(|_| DexError::InvalidProof)?;
            instruction_data_b.extend_from_slice(&args_data_b);
            
            // Construct and invoke
            let instruction_b = anchor_lang::solana_program::instruction::Instruction {
                program_id: POOL_PROGRAM_ID,
                accounts: account_metas_b,
                data: instruction_data_b,
            };
            
            anchor_lang::solana_program::program::invoke(
                &instruction_b,
                &account_infos_b,
            )?;
            
            msg!("[add_liquidity] ✓ Token B private_transfer CPI invoked successfully");
            
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

