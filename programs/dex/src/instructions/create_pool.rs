use anchor_lang::prelude::*;
use anchor_spl::token_interface::{InitializeMint2, MintTo, Transfer};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_program;
use spl_associated_token_account_client::{
    address::get_associated_token_address_with_program_id,
    instruction as ata_instruction,
};

use crate::errors::DexError;
use crate::state::DEX_POOL_SEED;
use crate::ztoken_cpi::{parse_ztoken_accounts, invoke_shield_cpi, ShieldArgs, extract_pool_commitment};
use ptf_pool::ID as POOL_PROGRAM_ID;
use ptf_vault::ID as VAULT_PROGRAM_ID;

pub fn create_pool(
    ctx: Context<crate::CreatePool>,
    initial_amount_a: u64,
    initial_amount_b: u64,
    shield_args_a: ShieldArgs,
    shield_args_b: ShieldArgs,
) -> Result<()> {
    // Allow 0 amounts for empty pool creation (liquidity can be added later via add_liquidity)
    // If amounts are 0, skip shield CPIs and LP token minting
    let is_empty_pool = initial_amount_a == 0 && initial_amount_b == 0;
    
    // If not empty, validate both amounts are > 0
    if !is_empty_pool {
        require!(initial_amount_a > 0, DexError::InvalidAmount);
        require!(initial_amount_b > 0, DexError::InvalidAmount);
    }
    
    // Validate token pair (must be in canonical order: token_a < token_b)
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    require!(
        token_a < token_b,
        DexError::InvalidTokenPair
    );
    require!(
        token_a != token_b,
        DexError::InvalidTokenPair
    );
    
    // Cache values before mutable borrow
    let lp_mint_key = ctx.accounts.lp_token_mint.key();
    let pool_state_key = ctx.accounts.pool_state.key();
    let token_program_key = ctx.accounts.token_program.key();
    let payer_pubkey = ctx.accounts.payer.key();
    
    // Store values for pool state updates after CPIs
    let mut private_reserve_a_commitment = [0u8; 32];
    let mut private_reserve_a_amount = initial_amount_a;
    let mut private_reserve_b_commitment = [0u8; 32];
    let mut private_reserve_b_amount = initial_amount_b;
    
    // Load pool state (will be initialized by Anchor's init constraint)
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Initialize pool state (both tokens are always zTokens)
    pool_state.token_a_mint = token_a;
    pool_state.token_b_mint = token_b;
    pool_state.private_reserve_a_commitment = private_reserve_a_commitment;
    pool_state.private_reserve_a_amount = private_reserve_a_amount;
    pool_state.private_reserve_b_commitment = private_reserve_b_commitment;
    pool_state.private_reserve_b_amount = private_reserve_b_amount;
    pool_state.lp_token_mint = lp_mint_key;
    
    // Calculate initial LP tokens: sqrt(amount_a * amount_b) - MIN_LIQUIDITY
    // For empty pools, set total_lp_supply to 0 (will be set when liquidity is added)
    let initial_lp = if is_empty_pool {
        0
    } else {
        const MIN_LIQUIDITY: u64 = 1000; // Minimum liquidity to prevent pool manipulation
        let lp_amount = (initial_amount_a as u128)
            .checked_mul(initial_amount_b as u128)
            .ok_or(DexError::MathOverflow)?;
        let lp_amount_sqrt = (lp_amount as f64).sqrt() as u64;
        lp_amount_sqrt
            .checked_sub(MIN_LIQUIDITY)
            .ok_or(DexError::MathOverflow)?
    };
    
    pool_state.total_lp_supply = initial_lp;
    pool_state.protocol_fee_accumulator_a = 0;
    pool_state.protocol_fee_accumulator_b = 0;
    pool_state.lp_fee_accumulator_a = 0;
    pool_state.lp_fee_accumulator_b = 0;
    pool_state.created_at = Clock::get()?.unix_timestamp;
    pool_state.bump = ctx.bumps.pool_state;
    
    // CRITICAL: Drop mutable borrow BEFORE accessing remaining_accounts
    // This prevents lifetime conflicts with Rust borrow checker
    drop(pool_state);
    
    // ====================================================================
    // ZTOKEN SHIELD CPIs - Both tokens are always zTokens
    // Skip shields if creating empty pool (liquidity will be added later)
    // ====================================================================
    if !is_empty_pool {
        // Shield token A to pool PDA
        msg!("[create_pool] Token A is zToken - invoking shield CPI");
        let commitment_a = handle_ztoken_shield_for_create_pool(
            ctx.remaining_accounts.to_vec(),
            &payer_pubkey,
            &token_a,
            &POOL_PROGRAM_ID,
            &VAULT_PROGRAM_ID,
            &token_program_key,
            shield_args_a,
            &pool_state_key,
            initial_amount_a,
            0,
        )?;
        
        if let Some(commitment) = commitment_a {
            private_reserve_a_commitment = commitment;
            private_reserve_a_amount = initial_amount_a;
        }
        
        // Shield token B to pool PDA
        msg!("[create_pool] Token B is zToken - invoking shield CPI");
        
        // Calculate offset: Token A uses first 14 accounts, Token B uses next 14
        let account_offset = 14;
        
        let commitment_b = handle_ztoken_shield_for_create_pool(
            ctx.remaining_accounts.to_vec(),
            &payer_pubkey,
            &token_b,
            &POOL_PROGRAM_ID,
            &VAULT_PROGRAM_ID,
            &token_program_key,
            shield_args_b,
            &pool_state_key,
            initial_amount_b,
            account_offset,
        )?;
        
        if let Some(commitment) = commitment_b {
            private_reserve_b_commitment = commitment;
            private_reserve_b_amount = initial_amount_b;
        }
    } else {
        msg!("[create_pool] Creating empty pool - skipping shield CPIs (liquidity will be added later via add_liquidity)");
    }
    
    // Re-acquire mutable borrow to update pool state with commitments
    let pool_state = &mut ctx.accounts.pool_state;
    pool_state.private_reserve_a_commitment = private_reserve_a_commitment;
    pool_state.private_reserve_a_amount = private_reserve_a_amount;
    pool_state.private_reserve_b_commitment = private_reserve_b_commitment;
    pool_state.private_reserve_b_amount = private_reserve_b_amount;
    
    // Drop mutable borrow before other operations
    drop(pool_state);
    
    // Prepare seeds for PDA signing (needed for LP mint operations below)
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[ctx.bumps.pool_state],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Initialize LP token mint if it's not already initialized
    // The mint account is created by SDK with TOKEN_PROGRAM_ID as owner, but data is empty/uninitialized
    let lp_mint_info = ctx.accounts.lp_token_mint.to_account_info();
    let is_token_program_owner = lp_mint_info.owner == &anchor_spl::token::ID 
        || lp_mint_info.owner == &anchor_spl::token_2022::ID;
    
    msg!("[create_pool] LP mint check: key={}, owner={}, data_empty={}", 
        lp_mint_info.key(), lp_mint_info.owner, lp_mint_info.data_is_empty());
    
    // Check if mint is uninitialized: data is empty OR mint_authority is None (first byte is 0)
    let mut is_uninitialized = lp_mint_info.data_is_empty();
    if !is_uninitialized {
        // Try to check if mint appears uninitialized by reading the first byte
        // For initialized mints, first byte is 1 (COption::Some) followed by the Pubkey
        // For uninitialized mints, first byte is 0 (COption::None)
        if let Ok(data) = lp_mint_info.try_borrow_data() {
            msg!("[create_pool] LP mint data length: {}, first byte: {}", data.len(), if data.len() > 0 { data[0] } else { 0 });
            if data.len() >= 1 && data[0] == 0 {
                is_uninitialized = true;
            }
        }
    }
    
    msg!("[create_pool] LP mint initialization check: is_token_program_owner={}, is_uninitialized={}", 
        is_token_program_owner, is_uninitialized);
    
    // Always try to initialize if owned by token program and appears uninitialized
    if is_token_program_owner && is_uninitialized {
        msg!("[create_pool] Initializing LP mint with decimals=9, authority={}", pool_state_key);
        // Mint account exists but is uninitialized - initialize it now
        // Use pool_state PDA as mint authority
        const LP_DECIMALS: u8 = 9; // Standard LP token decimals
        
        let init_mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            InitializeMint2 {
                mint: lp_mint_info.clone(),
            },
            signer_seeds,
        );
        
        match anchor_spl::token_interface::initialize_mint2(
            init_mint_ctx,
            LP_DECIMALS,
            &pool_state_key,
            None, // No freeze authority
        ) {
            Ok(_) => {
                msg!("[create_pool] ✓ LP mint initialized successfully");
            }
            Err(e) => {
                msg!("[create_pool] ⚠️  Failed to initialize LP mint: {:?}", e);
                return Err(e.into());
            }
        }
    } else {
        msg!("[create_pool] LP mint appears initialized or not owned by token program - skipping initialization");
        // Mint should already be initialized - validate it's owned by a token program
        let is_token_program = lp_mint_info.owner == &anchor_spl::token::ID 
            || lp_mint_info.owner == &anchor_spl::token_2022::ID;
        require!(
            is_token_program,
            DexError::InvalidMintFormat
        );
    }
    
    // Mint initial LP tokens to user (skip if empty pool)
    if !is_empty_pool {
        // Note: User LP token account must exist - SDK will create it after pool creation
        // If account doesn't exist or isn't a valid token account, skip minting (SDK will handle it in follow-up transaction)
        let user_lp_account_info = ctx.accounts.user_lp_token_account.to_account_info();
        let account_exists = user_lp_account_info.owner == &anchor_spl::token::ID 
            || user_lp_account_info.owner == &anchor_spl::token_2022::ID;
        let account_has_data = !user_lp_account_info.data_is_empty();
        
        if account_exists && account_has_data {
            // Account exists and is a token account - try to mint to it
            // Re-acquire pool_state for mint authority
            let pool_state = &ctx.accounts.pool_state;
            let mint_to_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_token_mint.to_account_info(),
                    to: ctx.accounts.user_lp_token_account.to_account_info(),
                    authority: pool_state.to_account_info(),
                },
                signer_seeds,
            );
            // Try to mint, but don't fail if it doesn't work (account might not be fully initialized)
            if let Err(e) = anchor_spl::token_interface::mint_to(mint_to_ctx, initial_lp) {
                msg!("Warning: Failed to mint initial LP tokens: {:?}. SDK will handle in follow-up transaction.", e);
            }
        } else {
            msg!("Warning: User LP token account does not exist or is not initialized. SDK will create it and mint tokens in follow-up transaction.");
        }
    } else {
        msg!("[create_pool] Empty pool created - skipping LP token minting (liquidity will be added later)");
    }
    
    msg!("[create_pool] Pool initialized with private reserves: A={}, B={}", 
        private_reserve_a_amount, private_reserve_b_amount);
    
    Ok(())
}

/// Helper function to handle zToken shield CPI for create_pool
/// Uses Vec pattern to break lifetime dependency
/// 
/// This performs a full shield CPI invocation, parsing all required accounts
/// and invoking ptf_pool::shield to create zTokens for the pool PDA.
fn handle_ztoken_shield_for_create_pool<'info>(
    remaining_accounts: Vec<AccountInfo<'info>>,
    payer_pubkey: &Pubkey,
    token_mint: &Pubkey,
    pool_program_id: &Pubkey,
    vault_program_id: &Pubkey,
    token_program_key: &Pubkey,
    shield_args: ShieldArgs,
    pool_state_key: &Pubkey,
    _amount: u64,
    account_offset: usize,
) -> Result<Option<[u8; 32]>> {
    msg!("[create_pool] Starting shield CPI for token_mint={}, pool_state_key={}", token_mint, pool_state_key);
    
    let ra = remaining_accounts.as_slice();
    require!(ra.len() > account_offset, DexError::InvalidAccount);
    
    // Parse zToken pool accounts - now includes vault_token_account and depositor_token_account
    let token_accounts_slice = &ra[account_offset..];
    let ztoken_accounts = crate::ztoken_cpi::parse_ztoken_accounts(
        token_accounts_slice,
        token_mint,
        pool_program_id,
        true, // is_shield = true
    )?;
    
    // Find additional accounts needed for shield CPI
    let mut origin_mint_account: Option<AccountInfo<'info>> = None;
    let mut vault_program_account: Option<AccountInfo<'info>> = None;
    let mut token_program_account: Option<AccountInfo<'info>> = None;
    
    // Find accounts by matching keys
    for account in ra.iter() {
        let key = account.key();
        
        // origin_mint matches token_mint
        if key == *token_mint {
            origin_mint_account = Some(account.clone());
            msg!("[create_pool] Found origin_mint: {}", key);
        }
        // vault_program matches vault_program_id
        else if key == *vault_program_id {
            vault_program_account = Some(account.clone());
            msg!("[create_pool] Found vault_program: {}", key);
        }
        // token_program matches token_program_key
        else if key == *token_program_key {
            token_program_account = Some(account.clone());
            msg!("[create_pool] Found token_program: {}", key);
        }
    }
    
    // Validate all required shield accounts are present
    require!(
        ztoken_accounts.vault_state.is_some(),
        DexError::InvalidAccount
    );
    require!(
        ztoken_accounts.shield_claim.is_some(),
        DexError::InvalidAccount
    );
    require!(
        ztoken_accounts.hook_config.is_some(),
        DexError::InvalidAccount
    );
    require!(
        ztoken_accounts.hook_whitelist.is_some(),
        DexError::InvalidAccount
    );
    require!(
        ztoken_accounts.factory_state.is_some(),
        DexError::InvalidAccount
    );
    
    // Build account metas and infos for shield instruction (21 accounts in ptf_pool::shield order)
    let mut account_metas = Vec::new();
    let mut account_infos: Vec<AccountInfo> = Vec::new();
    
    // Order matches ptf_pool Shield account struct:
    // 1. pool_state (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.pool_state.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.pool_state.clone());
    
    // 2. hook_config (PDA, readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.hook_config.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(ztoken_accounts.hook_config.as_ref().unwrap().clone());
    
    // 3. hook_whitelist (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.hook_whitelist.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(ztoken_accounts.hook_whitelist.as_ref().unwrap().clone());
    
    // 4. nullifier_set (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.nullifier_set.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.nullifier_set.clone());
    
    // 5. commitment_tree (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.commitment_tree.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.commitment_tree.clone());
    
    // 6. note_ledger (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.note_ledger.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.note_ledger.clone());
    
    // 7. vault_state (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.vault_state.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(ztoken_accounts.vault_state.as_ref().unwrap().clone());
    
    // 8. vault_token_account (writable) - need to find or use placeholder
    // For now, we'll need parse_ztoken_accounts to find this
    if let Some(ref vta) = ztoken_accounts.vault_token_account {
        account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
            vta.key(),
            false,
        ));
        account_infos.push(vta.clone());
    } else {
        return Err(DexError::InvalidAccount.into());
    }
    
    // 9. depositor_token_account (writable) - need to find or use placeholder  
    if let Some(ref dta) = ztoken_accounts.depositor_token_account {
        account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
            dta.key(),
            false,
        ));
        account_infos.push(dta.clone());
    } else {
        return Err(DexError::InvalidAccount.into());
    }
    
    // 10. twin_mint (optional, writable) - use origin_mint as placeholder for None
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        *pool_program_id, // Placeholder for None optional
        false,
    ));
    account_infos.push(ztoken_accounts.pool_state.clone()); // Dummy
    
    // 11. verifier_program (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.verifier_program.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.verifier_program.clone());
    
    // 12. verifying_key (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.verifying_key.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.verifying_key.clone());
    
    // 13. shield_claim (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts.shield_claim.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(ztoken_accounts.shield_claim.as_ref().unwrap().clone());
    
    // Extract common accounts (payer, system_program, rent) from end
    let (payer_account, system_program_account, rent_account) =
        crate::ztoken_cpi::parse_cpi_common_accounts(
            ra,
            payer_pubkey,
        )?;
    
    // 14. payer (signer, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        payer_account.key(),
        true,
    ));
    account_infos.push(payer_account);
    
    // 15. origin_mint (readonly)
    let origin_mint_account = origin_mint_account.ok_or(DexError::InvalidAccount)?;
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        origin_mint_account.key(),
        false,
    ));
    account_infos.push(origin_mint_account);
    
    // 16. mint_mapping (PDA, readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.mint_mapping.key(),
        false,
    ));
    account_infos.push(ztoken_accounts.mint_mapping.clone());
    
    // 17. factory_state (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts.factory_state.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(ztoken_accounts.factory_state.as_ref().unwrap().clone());
    
    // 18. vault_program (readonly)
    let vault_program_account = vault_program_account.unwrap_or_else(|| system_program_account.clone());
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        vault_program_account.key(),
        false,
    ));
    account_infos.push(vault_program_account);
    
    // 19. token_program (readonly)
    let token_program_account = token_program_account.unwrap_or_else(|| system_program_account.clone());
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        token_program_account.key(),
        false,
    ));
    account_infos.push(token_program_account);
    
    // 20. system_program (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        system_program_account.key(),
        false,
    ));
    account_infos.push(system_program_account);
    
    // 21. rent (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        rent_account.key(),
        false,
    ));
    account_infos.push(rent_account);
    
    // Build instruction data
    let mut instruction_data = Vec::new();
    let shield_discriminator: [u8; 8] = [220, 198, 253, 246, 148, 174, 48, 205];
    instruction_data.extend_from_slice(&shield_discriminator);
    
    let args_data = shield_args.try_to_vec()
        .map_err(|_| DexError::InvalidProof)?;
    instruction_data.extend_from_slice(&args_data);
    
    msg!("[create_pool] Shield instruction data prepared: {} bytes", instruction_data.len());
    
    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: *pool_program_id,
        accounts: account_metas,
        data: instruction_data,
    };
    
    msg!("[create_pool] Invoking ptf_pool::shield CPI...");
    anchor_lang::solana_program::program::invoke(
        &instruction,
        &account_infos,
    )?;
    
    msg!("[create_pool] ✓ shield CPI invoked successfully");
    
    // Return the commitment from shield_args
    Ok(Some(shield_args.amount_commit))
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution
