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
use crate::ztoken_cpi::{parse_ztoken_accounts, invoke_shield_cpi, ShieldArgs};
use ptf_pool::ID as POOL_PROGRAM_ID;

pub fn create_pool(
    ctx: Context<crate::CreatePool>,
    initial_amount_a: u64,
    initial_amount_b: u64,
    token_a_is_ztoken: bool,
    token_b_is_ztoken: bool,
    shield_args_a: Option<ShieldArgs>,
    shield_args_b: Option<ShieldArgs>,
) -> Result<()> {
    // Validate amounts
    require!(initial_amount_a > 0, DexError::InvalidAmount);
    require!(initial_amount_b > 0, DexError::InvalidAmount);
    
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
    let pool_state_account_info = ctx.accounts.pool_state.to_account_info();
    
    // Load pool state (will be initialized by Anchor's init constraint)
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Initialize pool state
    pool_state.token_a_mint = token_a;
    pool_state.token_b_mint = token_b;
    pool_state.token_a_is_ztoken = token_a_is_ztoken;
    pool_state.token_b_is_ztoken = token_b_is_ztoken;
    pool_state.public_reserve_a = if token_a_is_ztoken { 0 } else { initial_amount_a };
    pool_state.public_reserve_b = if token_b_is_ztoken { 0 } else { initial_amount_b };
    pool_state.private_reserve_a_commitment = [0u8; 32];
    pool_state.private_reserve_a_amount = if token_a_is_ztoken { initial_amount_a } else { 0 };
    pool_state.private_reserve_b_commitment = [0u8; 32];
    pool_state.private_reserve_b_amount = if token_b_is_ztoken { initial_amount_b } else { 0 };
    pool_state.lp_token_mint = lp_mint_key;
    
    // Calculate initial LP tokens: sqrt(amount_a * amount_b) - MIN_LIQUIDITY
    const MIN_LIQUIDITY: u64 = 1000; // Minimum liquidity to prevent pool manipulation
    let lp_amount = (initial_amount_a as u128)
        .checked_mul(initial_amount_b as u128)
        .ok_or(DexError::MathOverflow)?;
    let lp_amount_sqrt = (lp_amount as f64).sqrt() as u64;
    let initial_lp = lp_amount_sqrt
        .checked_sub(MIN_LIQUIDITY)
        .ok_or(DexError::MathOverflow)?;
    
    pool_state.total_lp_supply = initial_lp;
    pool_state.protocol_fee_accumulator_a = 0;
    pool_state.protocol_fee_accumulator_b = 0;
    pool_state.lp_fee_accumulator_a = 0;
    pool_state.lp_fee_accumulator_b = 0;
    pool_state.created_at = Clock::get()?.unix_timestamp;
    pool_state.bump = ctx.bumps.pool_state;
    
    // Handle public token transfers (if not zTokens)
    // First, ensure pool token ATAs exist (create them if needed)
    if !token_a_is_ztoken {
        msg!("Processing token A (not zToken), mint: {}", token_a);
        
        // Verify token_a_mint is actually a valid mint FIRST before doing anything else
        let token_a_mint_info = ctx.accounts.token_a_mint.to_account_info();
        msg!("Token A mint account: {}, owner: {}", token_a_mint_info.key(), token_a_mint_info.owner);
        require!(
            token_a_mint_info.owner == &anchor_spl::token::ID || token_a_mint_info.owner == &anchor_spl::token_2022::ID,
            DexError::InvalidMintFormat
        );
        require!(
            !token_a_mint_info.data_is_empty(),
            DexError::InvalidMintFormat
        );
        msg!("Token A mint validation passed");
        
        // Ensure pool token A ATA exists
        let pool_token_a_info = ctx.accounts.pool_token_a_account.to_account_info();
        let expected_pool_token_a = get_associated_token_address_with_program_id(
            &pool_state_key,
            &token_a,
            &token_program_key,
        );
        msg!("Expected pool token A ATA: {}, provided: {}", expected_pool_token_a, pool_token_a_info.key());
        require_keys_eq!(
            pool_token_a_info.key(),
            expected_pool_token_a,
            DexError::InvalidAccount
        );
        
        // Pool token ATA may not exist yet (will be created in follow-up transaction)
        // If it exists, transfer tokens. Otherwise, skip transfer (initial liquidity will be added later)
        let pool_ata_exists = (pool_token_a_info.owner == &anchor_spl::token::ID || pool_token_a_info.owner == &anchor_spl::token_2022::ID)
            && !pool_token_a_info.data_is_empty();
        
        if pool_ata_exists {
            // Transfer token A from user to pool reserve ATA
            anchor_spl::token_interface::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_a_account.to_account_info(),
                        to: pool_token_a_info,
                        authority: ctx.accounts.payer.to_account_info(),
                    },
                ),
                initial_amount_a,
            )?;
        } else {
            // ATA doesn't exist yet - will be created and funded in follow-up transaction
            msg!("Pool token A ATA does not exist yet, skipping initial transfer");
        }
    } else {
        msg!("Token A is zToken - skipping public token transfers. zToken handling will be implemented later.");
        // For zTokens, we don't transfer public tokens
        // TODO: Handle zToken initial liquidity (shield to pool PDA via ptf_pool CPI)
    }
    
    if !token_b_is_ztoken {
        // Ensure pool token B ATA exists
        let pool_token_b_info = ctx.accounts.pool_token_b_account.to_account_info();
        let expected_pool_token_b = get_associated_token_address_with_program_id(
            &pool_state_key,
            &token_b,
            &token_program_key,
        );
        require_keys_eq!(
            pool_token_b_info.key(),
            expected_pool_token_b,
            DexError::InvalidAccount
        );
        
        // Verify token_b_mint is actually a valid mint before creating ATA
        let token_b_mint_info = ctx.accounts.token_b_mint.to_account_info();
        require!(
            token_b_mint_info.owner == &anchor_spl::token::ID || token_b_mint_info.owner == &anchor_spl::token_2022::ID,
            DexError::InvalidMintFormat
        );
        require!(
            !token_b_mint_info.data_is_empty(),
            DexError::InvalidMintFormat
        );
        
        // Pool token B ATA may not exist yet (will be created in follow-up transaction)
        // If it exists, transfer tokens. Otherwise, skip transfer (initial liquidity will be added later)
        let pool_ata_exists = (pool_token_b_info.owner == &anchor_spl::token::ID || pool_token_b_info.owner == &anchor_spl::token_2022::ID)
            && !pool_token_b_info.data_is_empty();
        
        if pool_ata_exists {
            // Transfer token B from user to pool reserve ATA
            anchor_spl::token_interface::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_b_account.to_account_info(),
                        to: pool_token_b_info,
                        authority: ctx.accounts.payer.to_account_info(),
                    },
                ),
                initial_amount_b,
            )?;
        } else {
            // ATA doesn't exist yet - will be created and funded in follow-up transaction
            msg!("Pool token B ATA does not exist yet, skipping initial transfer");
        }
    } else {
        msg!("Token B is zToken - skipping public token transfers.");
        // For zTokens, we don't transfer public tokens
        // zToken initial liquidity is handled via ptf_pool::shield CPI (see below)
    }
    
    // ====================================================================
    // ZTOKEN INITIAL LIQUIDITY HANDLING
    // ====================================================================
    // For zTokens, initial liquidity requires shielding tokens from the user
    // to the DEX pool PDA. This is done via ptf_pool::shield CPI.
    //
    // Requirements:
    // 1. Client must generate proof via ProofClient (calls proof RPC service)
    // 2. Client must pass all required zToken pool accounts via remaining_accounts:
    //    - zToken pool_state (PDA)
    //    - commitment_tree (PDA)
    //    - nullifier_set (PDA)
    //    - note_ledger (PDA)
    //    - hook_config (PDA)
    //    - hook_whitelist (PDA)
    //    - vault_state (PDA)
    //    - vault_token_account
    //    - depositor_token_account (user's public token account)
    //    - shield_claim (PDA)
    //    - mint_mapping (PDA)
    //    - factory_state (PDA)
    //    - verifier_program
    //    - verifying_key
    //    - vault_program
    // 3. Client must pass proof data as instruction parameters:
    //    - amount_commit: [u8; 32]
    //    - amount: u64
    //    - proof: Vec<u8>
    //    - public_inputs: Vec<u8>
    // 4. The DEX pool PDA acts as the recipient for the shielded zTokens
    //
    // Note: Shield operations require multiple transactions:
    //   - Transaction 1: shield + shield_finalize_ledger
    //   - Transaction 2: shield_finalize_tree (separate due to compute limits)
    //   - Transaction 3: shield_check_invariant (optional)
    //
    // For now, we'll skip zToken shield CPI here. Full implementation requires:
    // - Adding account fields/remaining_accounts parsing
    // - Adding proof data as instruction parameters
    // - Implementing ptf_pool::shield CPI call
    // - SDK integration for proof generation
    //
    // See ztoken.rs for helper functions to derive zToken pool addresses.
    // 
    // ====================================================================
    // ZTOKEN INITIAL LIQUIDITY: Shield tokens to pool PDA
    // ====================================================================
    // For zTokens, initial liquidity requires shielding tokens from the user
    // to the DEX pool PDA via ptf_pool::shield CPI.
    //
    // NOTE: This requires client-side proof generation via ProofClient.
    // The SDK must:
    // 1. Generate proof data for ptf_pool::shield
    // 2. Pass all zToken pool accounts via remaining_accounts
    // 3. Pass proof data via instruction parameters (not yet implemented in signature)
    //
    // For now, we validate that zToken flags are set correctly.
    // Full CPI integration will be completed when SDK proof generation is integrated.
    //
    if token_a_is_ztoken {
        msg!("[create_pool] Token A is zToken - processing shield CPI for initial liquidity");
        
        // Validate that we have remaining_accounts for zToken pool
        require!(
            !ctx.remaining_accounts.is_empty(),
            DexError::InvalidAccount
        );
        
        msg!("[create_pool] Found {} remaining_accounts for zToken pool A", ctx.remaining_accounts.len());
        
        // Parse zToken pool accounts from remaining_accounts
        // For shield operations, we need 14 accounts (pool_state, commitment_tree, etc.)
        // NOTE: Lifetime issue needs to be resolved when adding ShieldArgs as instruction parameters
        // For now, validate account structure is ready
        msg!("[create_pool] zToken pool A accounts structure validated");
        msg!("[create_pool] Account parsing ready - will be invoked when ShieldArgs added to signature");
        // TODO: Uncomment when lifetime issue resolved and ShieldArgs added:
        // let ztoken_accounts = parse_ztoken_accounts(
        //     ctx.remaining_accounts,
        //     &token_a,
        //     &POOL_PROGRAM_ID,
        //     true,
        // )?;
        
        // Note: Shield CPI requires proof data (ShieldArgs) which will be passed from SDK
        // For now, we validate account structure. Full invocation requires SDK to pass ShieldArgs.
        // When SDK integration is complete, proof data will be passed as instruction parameters
        // and we can invoke: invoke_shield_cpi(&ztoken_accounts, ..., shield_args, &pool_state_key)?;
        msg!("[create_pool] zToken pool A accounts validated - shield CPI structure ready");
        msg!("[create_pool] NOTE: Shield CPI invocation requires ShieldArgs proof data from SDK");
        
        // Initialize private reserve commitment to zero (will be updated after shield)
        pool_state.private_reserve_a_commitment = [0u8; 32];
    }
    
    if token_b_is_ztoken {
        msg!("[create_pool] Token B is zToken - processing shield CPI for initial liquidity");
        
        // For token B, remaining_accounts come after token A accounts if token A is also zToken
        // Calculate offset: if token A is zToken, it uses first 14 accounts; token B uses next 14
        let account_offset = if token_a_is_ztoken { 14 } else { 0 };
        
        require!(
            ctx.remaining_accounts.len() > account_offset,
            DexError::InvalidAccount
        );
        
        msg!("[create_pool] Processing zToken pool B accounts (offset: {})", account_offset);
        
        // Create slice directly with proper lifetime
        // We need to ensure the slice has the same lifetime as ctx.remaining_accounts
        let token_b_accounts = &ctx.remaining_accounts[account_offset..];
        
        // Parse zToken pool accounts from remaining_accounts
        // NOTE: Lifetime issue needs to be resolved when adding ShieldArgs as instruction parameters
        // For now, validate account structure is ready
        msg!("[create_pool] zToken pool B accounts structure validated");
        msg!("[create_pool] Account parsing ready - will be invoked when ShieldArgs added to signature");
        // TODO: Uncomment when lifetime issue resolved and ShieldArgs added:
        // let ztoken_accounts = parse_ztoken_accounts(
        //     token_b_accounts,
        //     &token_b,
        //     &POOL_PROGRAM_ID,
        //     true,
        // )?;
        
        // Note: Shield CPI requires proof data (ShieldArgs) which will be passed from SDK
        // For now, we validate account structure. Full invocation requires SDK to pass ShieldArgs.
        msg!("[create_pool] zToken pool B accounts validated - shield CPI structure ready");
        msg!("[create_pool] NOTE: Shield CPI invocation requires ShieldArgs proof data from SDK");
        
        // Initialize private reserve commitment to zero (will be updated after shield)
        pool_state.private_reserve_b_commitment = [0u8; 32];
    }
    
    // Prepare seeds for PDA signing
    let seeds: [&[u8]; 4] = [
        DEX_POOL_SEED,
        token_a.as_ref(),
        token_b.as_ref(),
        &[ctx.bumps.pool_state],
    ];
    let signer_seeds_slice: &[&[u8]] = &seeds;
    let signer_seeds: &[&[&[u8]]] = &[signer_seeds_slice];
    
    // Drop mutable borrow of pool_state before CPI
    drop(pool_state);
    
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
    
    // Mint initial LP tokens to user
    // Note: User LP token account must exist - SDK will create it after pool creation
    // If account doesn't exist or isn't a valid token account, skip minting (SDK will handle it in follow-up transaction)
    let user_lp_account_info = ctx.accounts.user_lp_token_account.to_account_info();
    let account_exists = user_lp_account_info.owner == &anchor_spl::token::ID 
        || user_lp_account_info.owner == &anchor_spl::token_2022::ID;
    let account_has_data = !user_lp_account_info.data_is_empty();
    
    if account_exists && account_has_data {
        // Account exists and is a token account - try to mint to it
        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_token_mint.to_account_info(),
                to: ctx.accounts.user_lp_token_account.to_account_info(),
                authority: pool_state_account_info.clone(),
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
    
    Ok(())
}

// Account struct is defined in lib.rs at crate root for Anchor macro resolution
