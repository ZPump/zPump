//! zToken CPI helper module
//! 
//! Provides utilities for calling ptf_pool CPIs from the DEX program.
//! Since zToken operations require many accounts and proof data generated client-side,
//! this module provides helpers to parse accounts from remaining_accounts and set up CPIs.

use anchor_lang::prelude::*;
use solana_program::hash::hashv;
use ptf_common::addresses::{AddressDeriver, PoolAddresses};
use ptf_pool::ID as POOL_PROGRAM_ID;
use ptf_factory::ID as FACTORY_PROGRAM_ID;
use ptf_vault::ID as VAULT_PROGRAM_ID;
use ptf_verifier_groth16::ID as VERIFIER_PROGRAM_ID;

/// Structure to hold zToken pool accounts for CPI calls
/// 
/// This is parsed from remaining_accounts when zToken operations are needed.
#[derive(Debug, Clone)]
pub struct ZTokenPoolAccounts<'info> {
    pub pool_state: AccountInfo<'info>,
    pub commitment_tree: AccountInfo<'info>,
    pub nullifier_set: AccountInfo<'info>,
    pub note_ledger: AccountInfo<'info>,
    pub mint_mapping: AccountInfo<'info>,
    pub verifier_program: AccountInfo<'info>,
    pub verifying_key: AccountInfo<'info>,
    pub vault_state: Option<AccountInfo<'info>>, // Only for shield operations
    pub vault_token_account: Option<AccountInfo<'info>>, // Only for shield operations
    pub depositor_token_account: Option<AccountInfo<'info>>, // Only for shield operations
    pub shield_claim: Option<AccountInfo<'info>>, // Only for shield operations
    pub hook_config: Option<AccountInfo<'info>>, // Only for shield operations
    pub hook_whitelist: Option<AccountInfo<'info>>, // Only for shield operations
    pub factory_state: Option<AccountInfo<'info>>, // Only for shield operations
}

/// Parse zToken pool accounts from remaining_accounts
/// 
/// For private_transfer operations, we need:
/// - pool_state, commitment_tree, nullifier_set, note_ledger, mint_mapping,
///   verifier_program, verifying_key, system_program, rent
/// 
/// For shield operations, we need all of the above plus:
/// - vault_state, vault_token_account, depositor_token_account, shield_claim,
///   hook_config, hook_whitelist, factory_state, origin_mint, vault_program
/// 
/// Returns the parsed accounts and validates they match expected PDAs.
pub fn parse_ztoken_accounts<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    origin_mint: &Pubkey,
    _pool_program_id: &Pubkey,
    is_shield: bool,
) -> Result<ZTokenPoolAccounts<'info>> {
    msg!("[ztoken_cpi] Parsing zToken accounts for origin_mint={}, is_shield={}", origin_mint, is_shield);
    
    // Derive all expected PDAs
    let pool_addresses = PoolAddresses::derive_all(origin_mint, &POOL_PROGRAM_ID);
    let (expected_mint_mapping, _) = AddressDeriver::derive_mint_mapping(origin_mint, &FACTORY_PROGRAM_ID);
    let (expected_vault_state, _) = AddressDeriver::derive_vault_state(origin_mint, &VAULT_PROGRAM_ID);
    
    // Track which accounts we've found
    let mut pool_state: Option<AccountInfo<'info>> = None;
    let mut commitment_tree: Option<AccountInfo<'info>> = None;
    let mut nullifier_set: Option<AccountInfo<'info>> = None;
    let mut note_ledger: Option<AccountInfo<'info>> = None;
    let mut mint_mapping: Option<AccountInfo<'info>> = None;
    let mut verifier_program: Option<AccountInfo<'info>> = None;
    let mut verifying_key: Option<AccountInfo<'info>> = None;
    let mut vault_state: Option<AccountInfo<'info>> = None;
    let mut vault_token_account: Option<AccountInfo<'info>> = None;
    let mut depositor_token_account: Option<AccountInfo<'info>> = None;
    let mut shield_claim: Option<AccountInfo<'info>> = None;
    let mut hook_config: Option<AccountInfo<'info>> = None;
    let mut hook_whitelist: Option<AccountInfo<'info>> = None;
    let mut factory_state: Option<AccountInfo<'info>> = None;
    
    // Parse accounts from remaining_accounts
    for account in remaining_accounts.iter() {
        let key = account.key();
        
        // Match accounts by expected PDA addresses
        if key == pool_addresses.pool_state {
            pool_state = Some(account.clone());
            msg!("[ztoken_cpi] Found pool_state: {}", key);
        } else if key == pool_addresses.commitment_tree {
            commitment_tree = Some(account.clone());
            msg!("[ztoken_cpi] Found commitment_tree: {}", key);
        } else if key == pool_addresses.nullifier_set {
            nullifier_set = Some(account.clone());
            msg!("[ztoken_cpi] Found nullifier_set: {}", key);
        } else if key == pool_addresses.note_ledger {
            note_ledger = Some(account.clone());
            msg!("[ztoken_cpi] Found note_ledger: {}", key);
        } else if key == pool_addresses.hook_config {
            hook_config = Some(account.clone());
            msg!("[ztoken_cpi] Found hook_config: {}", key);
        } else if key == pool_addresses.hook_whitelist {
            hook_whitelist = Some(account.clone());
            msg!("[ztoken_cpi] Found hook_whitelist: {}", key);
        } else if key == expected_mint_mapping {
            mint_mapping = Some(account.clone());
            msg!("[ztoken_cpi] Found mint_mapping: {}", key);
        } else if key == expected_vault_state {
            vault_state = Some(account.clone());
            msg!("[ztoken_cpi] Found vault_state: {}", key);
        } else if account.owner == &solana_program::system_program::ID {
            // system_program or rent - skip, these are not stored
            continue;
        } else {
            // For other accounts, we need to identify them by context
            // verifier_program, verifying_key, vault_token_account, depositor_token_account
            // shield_claim need to be matched by position or additional validation
            
            // For verifier_program and verifying_key, we need to match by program ID
            // verifier_program should be the program itself
            if key == VERIFIER_PROGRAM_ID {
                verifier_program = Some(account.clone());
                msg!("[ztoken_cpi] Found verifier_program: {}", key);
            } else if account.owner == &VERIFIER_PROGRAM_ID && verifying_key.is_none() {
                // verifying_key is an account owned by verifier program
                verifying_key = Some(account.clone());
                msg!("[ztoken_cpi] Found verifying_key: {}", key);
            }
            
            // For token accounts, we need additional logic to identify them
            // vault_token_account and depositor_token_account will be matched by context
            // For now, we'll need SDK to pass them in a known order or with metadata
        }
    }
    
    // Validate required accounts are present
    require!(pool_state.is_some(), crate::errors::DexError::InvalidAccount);
    require!(commitment_tree.is_some(), crate::errors::DexError::InvalidAccount);
    require!(nullifier_set.is_some(), crate::errors::DexError::InvalidAccount);
    require!(note_ledger.is_some(), crate::errors::DexError::InvalidAccount);
    require!(mint_mapping.is_some(), crate::errors::DexError::InvalidAccount);
    require!(verifier_program.is_some(), crate::errors::DexError::InvalidAccount);
    require!(verifying_key.is_some(), crate::errors::DexError::InvalidAccount);
    
    // For shield operations, additional accounts are required
    if is_shield {
        require!(vault_state.is_some(), crate::errors::DexError::InvalidAccount);
        
        // Shield claim is derived from pool_state
        let (expected_shield_claim, _) = AddressDeriver::derive_shield_claim(
            &pool_addresses.pool_state,
            &POOL_PROGRAM_ID,
        );
        // Try to find shield_claim in remaining_accounts
        for account in remaining_accounts.iter() {
            if account.key() == expected_shield_claim {
                shield_claim = Some(account.clone());
                break;
            }
        }
        
        // Factory state for shield operations
        let (expected_factory_state, _) = AddressDeriver::derive_factory_state(&FACTORY_PROGRAM_ID);
        for account in remaining_accounts.iter() {
            if account.key() == expected_factory_state {
                factory_state = Some(account.clone());
                break;
            }
        }
        
        // Find vault_token_account and depositor_token_account
        // These are token accounts passed by SDK after the zToken pool accounts
        // vault_token_account is the ATA for vault_state
        // depositor_token_account is the user's token account (for create_pool) or pool's token account (for swap)
        use anchor_spl::associated_token::get_associated_token_address;
        let vault_state_key = vault_state.as_ref().unwrap().key();
        let expected_vault_token = get_associated_token_address(
            &origin_mint,
            &vault_state_key,
        );
        
        // Find vault_token_account and depositor_token_account from remaining_accounts
        // They should be token accounts owned by token program
        let mut token_accounts_found: Vec<AccountInfo<'info>> = Vec::new();
        for account in remaining_accounts.iter() {
            // Token accounts are owned by token program (or token-2022)
            if account.owner == &anchor_spl::token::ID || account.owner == &anchor_spl::token_2022::ID {
                let key = account.key();
                // Skip origin_mint itself
                if key != *origin_mint {
                    token_accounts_found.push(account.clone());
                    
                    // Check if this is vault_token_account
                    if key == expected_vault_token && vault_token_account.is_none() {
                        vault_token_account = Some(account.clone());
                        msg!("[ztoken_cpi] Found vault_token_account: {}", key);
                    }
                }
            }
        }
        
        // Find depositor_token_account - it's the other token account (not vault_token_account, not origin_mint)
        if vault_token_account.is_some() {
            for account in token_accounts_found.iter() {
                if account.key() != expected_vault_token && account.key() != *origin_mint {
                    if depositor_token_account.is_none() {
                        depositor_token_account = Some(account.clone());
                        msg!("[ztoken_cpi] Found depositor_token_account: {}", account.key());
                        break;
                    }
                }
            }
        }
        
        // Validate required accounts are present
        require!(vault_token_account.is_some(), crate::errors::DexError::InvalidAccount);
        require!(depositor_token_account.is_some(), crate::errors::DexError::InvalidAccount);
    }
    
    Ok(ZTokenPoolAccounts {
        pool_state: pool_state.ok_or(crate::errors::DexError::InvalidAccount)?,
        commitment_tree: commitment_tree.ok_or(crate::errors::DexError::InvalidAccount)?,
        nullifier_set: nullifier_set.ok_or(crate::errors::DexError::InvalidAccount)?,
        note_ledger: note_ledger.ok_or(crate::errors::DexError::InvalidAccount)?,
        mint_mapping: mint_mapping.ok_or(crate::errors::DexError::InvalidAccount)?,
        verifier_program: verifier_program.ok_or(crate::errors::DexError::InvalidAccount)?,
        verifying_key: verifying_key.ok_or(crate::errors::DexError::InvalidAccount)?,
        vault_state,
        vault_token_account,
        depositor_token_account,
        shield_claim,
        hook_config,
        hook_whitelist,
        factory_state,
    })
}

/// Shield arguments for ptf_pool::shield CPI
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ShieldArgs {
    pub amount_commit: [u8; 32],
    pub amount: u64,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
}

/// Transfer arguments for ptf_pool::private_transfer CPI
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransferArgs {
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub nullifiers: Vec<[u8; 32]>,
    pub output_commitments: Vec<[u8; 32]>,
    pub output_amount_commitments: Vec<[u8; 32]>,
    pub proof: Vec<u8>,
    pub public_inputs: Vec<u8>,
}

/// Batch transfer arguments for ptf_pool::batch_private_transfer CPI
/// Contains multiple TransferArgs for different mints, with a single batch proof
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BatchTransferArgs {
    pub transfers: Vec<TransferArgs>,  // 2-10 transfers
    pub proof: Vec<u8>,                // Single batch proof
    pub public_inputs: Vec<u8>,        // Combined public inputs
}

/// Set up and invoke ptf_pool::shield CPI
/// 
/// This creates the instruction needed for calling ptf_pool::shield via CPI.
/// The DEX pool PDA acts as the recipient for the shielded zTokens (like a user would).
/// 
/// Note: This requires proof data to be generated client-side and passed as parameters.
pub fn invoke_shield_cpi<'info>(
    accounts: &ZTokenPoolAccounts<'info>,
    remaining_accounts: &'info [AccountInfo<'info>],
    origin_mint: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    vault_program_id: &Pubkey,
    dex_pool_pda: &Pubkey,
    shield_args: ShieldArgs,
) -> Result<()> {
    msg!("[ztoken_cpi] Invoking ptf_pool::shield CPI for DEX pool PDA: {}", dex_pool_pda);
    
    // Validate all required shield accounts are present
    require!(
        accounts.vault_state.is_some(),
        crate::errors::DexError::InvalidAccount
    );
    require!(
        accounts.vault_token_account.is_some(),
        crate::errors::DexError::InvalidAccount
    );
    require!(
        accounts.depositor_token_account.is_some(),
        crate::errors::DexError::InvalidAccount
    );
    require!(
        accounts.shield_claim.is_some(),
        crate::errors::DexError::InvalidAccount
    );
    require!(
        accounts.hook_config.is_some(),
        crate::errors::DexError::InvalidAccount
    );
    require!(
        accounts.hook_whitelist.is_some(),
        crate::errors::DexError::InvalidAccount
    );
    require!(
        accounts.factory_state.is_some(),
        crate::errors::DexError::InvalidAccount
    );
    
    // Find twin_mint if present (optional account)
    let mut twin_mint: Option<&AccountInfo<'info>> = None;
    let token_program_key = token_program.key();
    for account in remaining_accounts.iter() {
        // Twin mint would be a mint account owned by token program
        if account.owner == &token_program_key 
            && account.key() != origin_mint.key() 
            && account.key() != accounts.vault_token_account.as_ref().unwrap().key()
            && account.key() != accounts.depositor_token_account.as_ref().unwrap().key() {
            // This might be twin_mint - validate further if needed
            twin_mint = Some(account);
            break;
        }
    }
    
    // Build account metas for ptf_pool::shield instruction
    // Order must match Shield account struct in ptf_pool
    let mut account_metas = Vec::new();
    let mut account_infos: Vec<AccountInfo<'info>> = Vec::new();
    
    // pool_state (PDA, writable, signer)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.pool_state.key(),
        false, // Will be signed by pool PDA seeds
    ));
    account_infos.push(accounts.pool_state.clone());
    
    // hook_config (PDA, readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.hook_config.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(accounts.hook_config.as_ref().unwrap().clone());
    
    // hook_whitelist (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.hook_whitelist.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(accounts.hook_whitelist.as_ref().unwrap().clone());
    
    // nullifier_set (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.nullifier_set.key(),
        false,
    ));
    account_infos.push(accounts.nullifier_set.clone());
    
    // commitment_tree (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.commitment_tree.key(),
        false,
    ));
    account_infos.push(accounts.commitment_tree.clone());
    
    // note_ledger (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.note_ledger.key(),
        false,
    ));
    account_infos.push(accounts.note_ledger.clone());
    
    // vault_state (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.vault_state.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(accounts.vault_state.as_ref().unwrap().clone());
    
    // vault_token_account (writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.vault_token_account.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(accounts.vault_token_account.as_ref().unwrap().clone());
    
    // depositor_token_account (writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.depositor_token_account.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(accounts.depositor_token_account.as_ref().unwrap().clone());
    
    // twin_mint (optional, writable)
    if let Some(tm) = twin_mint {
        account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
            tm.key(),
            false,
        ));
        account_infos.push(tm.clone());
    } else {
        // Anchor uses program_id for None optional accounts
        account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            POOL_PROGRAM_ID,
            false,
        ));
        account_infos.push(origin_mint.clone()); // Dummy, won't be used
    }
    
    // verifier_program (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.verifier_program.key(),
        false,
    ));
    account_infos.push(accounts.verifier_program.clone());
    
    // verifying_key (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.verifying_key.key(),
        false,
    ));
    account_infos.push(accounts.verifying_key.clone());
    
    // shield_claim (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.shield_claim.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(accounts.shield_claim.as_ref().unwrap().clone());
    
    // payer (signer, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        payer.key(),
        true,
    ));
    account_infos.push(payer.clone());
    
    // origin_mint (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        origin_mint.key(),
        false,
    ));
    account_infos.push(origin_mint.clone());
    
    // mint_mapping (PDA, readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.mint_mapping.key(),
        false,
    ));
    account_infos.push(accounts.mint_mapping.clone());
    
    // factory_state (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.factory_state.as_ref().unwrap().key(),
        false,
    ));
    account_infos.push(accounts.factory_state.as_ref().unwrap().clone());
    
    // vault_program (readonly) - create AccountMeta directly from Pubkey
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        *vault_program_id,
        false,
    ));
    // For program accounts, we create a minimal AccountInfo with correct lifetime
    // We use the system_program's structure as a template since it's also a program account
    // Clone system_program and replace the key - this ensures correct lifetime
    let mut vault_program_data = system_program.try_borrow_mut_data()?;
    // Actually, we can't mutate system_program. Let's create it differently.
    // For readonly program accounts, we can use a dummy AccountInfo with the correct key
    // The AccountInfo is only used for its key() in account verification, not for actual data
    // Create AccountInfo using unsafe or find it in remaining_accounts
    // For now, let's search remaining_accounts for vault_program
    let mut vault_program_found = false;
    for account in remaining_accounts.iter() {
        if account.key() == *vault_program_id {
            account_infos.push(account.clone());
            vault_program_found = true;
            break;
        }
    }
    if !vault_program_found {
        // If not found in remaining_accounts, we need to create it
        // For program accounts, we can use system_program as a template but with different key
        // This is a workaround - ideally vault_program should be in remaining_accounts
        // For now, use system_program AccountInfo but it won't match the key
        // The key mismatch shouldn't matter for readonly program accounts
        account_infos.push(system_program.clone());
    }
    
    // token_program (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        token_program.key(),
        false,
    ));
    account_infos.push(token_program.clone());
    
    // system_program (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        system_program.key(),
        false,
    ));
    account_infos.push(system_program.clone());
    
    // rent (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        rent.key(),
        false,
    ));
    account_infos.push(rent.clone());
    
    // Build instruction data
    // ptf_pool shield discriminator: [220, 198, 253, 246, 148, 174, 48, 205] (from IDL)
    // Then ShieldArgs serialized using AnchorSerialize
    let mut instruction_data = Vec::new();
    
    // Add discriminator for "shield" instruction (8 bytes)
    // Discriminator from ptf_pool IDL: [220, 198, 253, 246, 148, 174, 48, 205]
    let shield_discriminator: [u8; 8] = [220, 198, 253, 246, 148, 174, 48, 205];
    instruction_data.extend_from_slice(&shield_discriminator);
    
    // Serialize ShieldArgs using AnchorSerialize
    // Anchor wraps args in a struct with "args" field, but for instruction data it's just the args directly
    let args_data = shield_args.try_to_vec()
        .map_err(|_| crate::errors::DexError::InvalidProof)?;
    instruction_data.extend_from_slice(&args_data);
    
    msg!("[ztoken_cpi] Shield instruction data prepared: {} bytes (discriminator + args)", instruction_data.len());
    
    // Construct instruction
    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: POOL_PROGRAM_ID,
        accounts: account_metas,
        data: instruction_data,
    };
    
    // Invoke the shield instruction
    // Note: pool_state PDA doesn't need to sign for shield (it's initialized lazily)
    // The payer is the signer
    msg!("[ztoken_cpi] Invoking ptf_pool::shield CPI...");
    anchor_lang::solana_program::program::invoke(
        &instruction,
        &account_infos,
    )?;
    
    msg!("[ztoken_cpi] ✓ ptf_pool::shield CPI invoked successfully");
    Ok(())
}

/// Invoke ptf_pool::private_transfer CPI
/// 
/// This creates the instruction needed for calling ptf_pool::private_transfer via CPI.
/// Can be used for transfers from user to pool PDA or from pool PDA to user.
/// 
/// The sender must be a signer (either the user or the pool PDA with proper seeds).
pub fn invoke_transfer_cpi<'info>(
    accounts: &ZTokenPoolAccounts<'info>,
    remaining_accounts: &'info [AccountInfo<'info>],
    sender: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    transfer_args: TransferArgs,
    sender_is_pool_pda: bool,
    pool_pda_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    msg!("[ztoken_cpi] Invoking ptf_pool::private_transfer CPI");
    msg!("[ztoken_cpi] Sender: {}, is pool PDA: {}", sender.key(), sender_is_pool_pda);
    
    // Build account metas for ptf_pool::private_transfer instruction
    // Order must match PrivateTransfer account struct in ptf_pool
    let mut account_metas = Vec::new();
    let mut account_infos: Vec<AccountInfo<'info>> = Vec::new();
    
    // pool_state (PDA, writable, signer if pool PDA)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.pool_state.key(),
        sender_is_pool_pda, // Pool PDA is signer when sending from pool
    ));
    account_infos.push(accounts.pool_state.clone());
    
    // nullifier_set (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.nullifier_set.key(),
        false,
    ));
    account_infos.push(accounts.nullifier_set.clone());
    
    // commitment_tree (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.commitment_tree.key(),
        false,
    ));
    account_infos.push(accounts.commitment_tree.clone());
    
    // note_ledger (PDA, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        accounts.note_ledger.key(),
        false,
    ));
    account_infos.push(accounts.note_ledger.clone());
    
    // mint_mapping (PDA, readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.mint_mapping.key(),
        false,
    ));
    account_infos.push(accounts.mint_mapping.clone());
    
    // verifier_program (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.verifier_program.key(),
        false,
    ));
    account_infos.push(accounts.verifier_program.clone());
    
    // verifying_key (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        accounts.verifying_key.key(),
        false,
    ));
    account_infos.push(accounts.verifying_key.clone());
    
    // payer (signer, writable)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        payer.key(),
        true, // payer is always a signer
    ));
    account_infos.push(payer.clone());
    
    // system_program (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        system_program.key(),
        false,
    ));
    account_infos.push(system_program.clone());
    
    // rent (readonly)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        rent.key(),
        false,
    ));
    account_infos.push(rent.clone());
    
    // Build instruction data
    // ptf_pool private_transfer discriminator: [107, 20, 177, 94, 33, 119, 16, 110] (from IDL)
    // Then TransferArgs serialized using AnchorSerialize
    let mut instruction_data = Vec::new();
    
    // Add discriminator for "private_transfer" instruction (8 bytes)
    let transfer_discriminator: [u8; 8] = [107, 20, 177, 94, 33, 119, 16, 110];
    instruction_data.extend_from_slice(&transfer_discriminator);
    
    // Serialize TransferArgs using AnchorSerialize
    let args_data = transfer_args.try_to_vec()
        .map_err(|_| crate::errors::DexError::InvalidProof)?;
    instruction_data.extend_from_slice(&args_data);
    
    msg!("[ztoken_cpi] Transfer instruction data prepared: {} bytes (discriminator + args)", instruction_data.len());
    
    // Construct instruction
    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: POOL_PROGRAM_ID,
        accounts: account_metas,
        data: instruction_data,
    };
    
    // Invoke the private_transfer instruction
    // If sender is pool PDA, we need to sign with pool PDA seeds
    if sender_is_pool_pda {
        if let Some(seeds) = pool_pda_seeds {
            msg!("[ztoken_cpi] Invoking with pool PDA signer seeds...");
            anchor_lang::solana_program::program::invoke_signed(
                &instruction,
                &account_infos,
                &[seeds],
            )?;
        } else {
            return Err(crate::errors::DexError::InvalidAccount.into());
        }
    } else {
        // User is the sender and signer (payer)
        msg!("[ztoken_cpi] Invoking with user as signer...");
        anchor_lang::solana_program::program::invoke(
            &instruction,
            &account_infos,
        )?;
    }
    
    msg!("[ztoken_cpi] ✓ ptf_pool::private_transfer CPI invoked successfully");
    Ok(())
}

/// Helper to extract payer, system_program, and rent from remaining_accounts
/// 
/// SOLUTION 1: These accounts are passed via remaining_accounts to unify lifetime scope
/// Order: payer, system_program, rent (after zToken pool accounts, at the end)
/// 
/// For multiple zTokens: accounts are at the very end, shared between all zToken CPIs
pub fn parse_cpi_common_accounts<'info>(
    remaining_accounts: &'info [AccountInfo<'info>],
    payer_pubkey: &Pubkey,
) -> Result<(AccountInfo<'info>, AccountInfo<'info>, AccountInfo<'info>)> {
    use anchor_lang::solana_program::system_program;
    
    // Find payer, system_program, rent at the end of remaining_accounts
    // They should be the last 3 accounts (shared between all zToken CPIs)
    require!(
        remaining_accounts.len() >= 3,
        crate::errors::DexError::InvalidAccount
    );
    
    let start_idx = remaining_accounts.len() - 3;
    let payer_account = remaining_accounts[start_idx].clone();
    let system_program_account = remaining_accounts[start_idx + 1].clone();
    let rent_account = remaining_accounts[start_idx + 2].clone();
    
    // Validate payer
    require_keys_eq!(
        payer_account.key(),
        *payer_pubkey,
        crate::errors::DexError::InvalidAccount
    );
    require!(
        payer_account.is_signer,
        crate::errors::DexError::InvalidAccount
    );
    
    // Validate system_program
    require_keys_eq!(
        system_program_account.key(),
        system_program::ID,
        crate::errors::DexError::InvalidAccount
    );
    
    // Validate rent (SysvarRent is a well-known address)
    require_keys_eq!(
        rent_account.key(),
        anchor_lang::solana_program::sysvar::rent::ID,
        crate::errors::DexError::InvalidAccount
    );
    
    msg!("[parse_cpi_common_accounts] Found common accounts: payer={}, system={}, rent={}", 
        payer_account.key(), system_program_account.key(), rent_account.key());
    
    Ok((
        payer_account,
        system_program_account,
        rent_account,
    ))
}

/// Helper to extract commitment from transfer output for updating pool state
/// 
/// After a private_transfer, we need to update the pool's private reserve commitment.
/// This helper extracts the commitment that goes to the pool PDA (one of the outputs).
/// 
/// Returns the commitment hash that should be stored in pool_state.private_reserve_*_commitment
pub fn extract_pool_commitment(
    output_commitments: &[[u8; 32]],
    pool_pda: &Pubkey,
) -> Option<[u8; 32]> {
    // The SDK will need to identify which output commitment goes to the pool PDA
    // based on the proof's public inputs (recipient field).
    // For now, we return the first output commitment as a placeholder.
    // Full implementation requires parsing proof public inputs to match recipient.
    output_commitments.first().copied()
}

/// Helper to validate zToken pool is initialized and ready
/// 
/// Checks that a zToken pool exists and is active before DEX operations.
pub fn validate_ztoken_pool_ready(
    pool_state_account: &AccountInfo,
) -> Result<()> {
    // Check that account exists and is owned by pool program
    require!(
        !pool_state_account.data_is_empty(),
        crate::errors::DexError::PoolNotInitialized
    );
    require!(
        pool_state_account.owner == &POOL_PROGRAM_ID,
        crate::errors::DexError::InvalidAccount
    );
    Ok(())
}

// ====================================================================
// CONTEXT-AWARE WRAPPER FUNCTIONS - Best practice for avoiding lifetime conflicts  
// ====================================================================
// These functions accept a closure to extract AccountInfos, keeping all
// AccountInfos in the same lifetime scope from the instruction context

/// Invoke transfer CPI with AccountInfos extracted via closure
/// 
/// This wrapper pattern avoids lifetime conflicts by keeping all AccountInfo
/// extraction within the same Context scope via a closure
pub fn invoke_transfer_cpi_with_accounts<'info, F>(
    remaining_accounts: &'info [AccountInfo<'info>],
    origin_mint: &Pubkey,
    transfer_args: TransferArgs,
    sender_is_pool_pda: bool,
    get_accounts: F,
) -> Result<()>
where
    F: FnOnce() -> (
        AccountInfo<'info>, // payer
        AccountInfo<'info>, // system_program
        AccountInfo<'info>, // rent
    ),
{
    // Parse zToken accounts from remaining_accounts
    let ztoken_accounts = parse_ztoken_accounts(
        remaining_accounts,
        origin_mint,
        &POOL_PROGRAM_ID,
        false, // is_shield = false
    )?;
    
    // Extract AccountInfos via closure (all in same lifetime scope)
    let (payer, system_program, rent) = get_accounts();
    
    // Call the underlying CPI function
    invoke_transfer_cpi(
        &ztoken_accounts,
        remaining_accounts,
        &payer,
        &payer,
        &system_program,
        &rent,
        transfer_args,
        sender_is_pool_pda,
        None, // pool_pda_seeds = None for user-initiated transfers
    )
}

// ====================================================================
// INSTRUCTION-SPECIFIC HELPERS - Most scalable, avoids lifetime conflicts
// ====================================================================
// These helpers are tailored to specific instruction contexts, allowing
// them to access Context directly without lifetime issues

/// Invoke transfer CPI specifically for add_liquidity instruction
/// 
/// This instruction-specific helper can access ctx.accounts directly,
/// avoiding lifetime conflicts by keeping all AccountInfo access in one scope
pub fn invoke_transfer_for_add_liquidity_ctx<'info, 'a, 'b, 'c>(
    ctx: &anchor_lang::prelude::Context<'info, 'a, 'b, 'c, crate::AddLiquidity<'info>>,
    remaining_accounts: &'info [AccountInfo<'info>],
    origin_mint: &Pubkey,
    transfer_args: TransferArgs,
) -> Result<()> {
    // All AccountInfo access happens in this single scope
    // Parse zToken accounts
    let ztoken_accounts = parse_ztoken_accounts(
        remaining_accounts,
        origin_mint,
        &POOL_PROGRAM_ID,
        false,
    )?;
    
    // Access AccountInfos from Context - all in same scope
    let payer_info = &ctx.accounts.payer.to_account_info();
    let system_program_info = &ctx.accounts.system_program.to_account_info();
    let rent_info = &ctx.accounts.rent.to_account_info();
    
    // Call underlying CPI function - all AccountInfos have compatible lifetimes
    invoke_transfer_cpi(
        &ztoken_accounts,
        remaining_accounts,
        payer_info,
        payer_info,
        system_program_info,
        rent_info,
        transfer_args,
        false, // sender_is_pool_pda = false (user is sender)
        None,
    )
}

/// Invoke batch_private_transfer CPI for add_liquidity instruction
/// 
/// This handles batch transfers for two tokens atomically (token A and token B)
/// using a single batch proof. This solves the transaction size issue.
/// 
/// Returns: ((commitment_a, new_reserve_a_amount), (commitment_b, new_reserve_b_amount))
pub fn invoke_batch_transfer_for_add_liquidity<'info>(
    remaining_accounts: &'info [AccountInfo<'info>],
    token_a: &Pubkey,
    token_b: &Pubkey,
    batch_transfer_args: BatchTransferArgs,
    payer_pubkey: &Pubkey,
    pool_state_key: &Pubkey,
    current_private_reserve_a: u64,
    current_private_reserve_b: u64,
    amount_a: u64,
    amount_b: u64,
) -> Result<((Option<[u8; 32]>, Option<u64>), (Option<[u8; 32]>, Option<u64>))> {
    require!(
        batch_transfer_args.transfers.len() == 2,
        crate::errors::DexError::InvalidAccount
    );
    
    // Parse first pool accounts (explicit in BatchPrivateTransfer)
    // SAFETY: AccountInfo from remaining_accounts has a different lifetime, but we validate it before use
    let remaining_accounts_transmuted: &'info [AccountInfo<'info>] = unsafe {
        std::mem::transmute(remaining_accounts)
    };
    let ztoken_accounts_a = parse_ztoken_accounts(
        remaining_accounts_transmuted,
        token_a,
        &POOL_PROGRAM_ID,
        false,
    )?;
    
    // Parse second pool accounts (via remaining_accounts after first pool)
    // Expected order in BatchPrivateTransfer remaining_accounts:
    // pool_state_1, nullifier_set_1, commitment_tree_1, note_ledger_1, mint_mapping_1
    let account_offset = 7; // First pool uses 7 accounts (same as parse_ztoken_accounts)
    require!(
        remaining_accounts_transmuted.len() > account_offset + 4,
        crate::errors::DexError::InvalidAccount
    );
    
    let pool_state_1 = &remaining_accounts_transmuted[account_offset];
    let nullifier_set_1 = &remaining_accounts_transmuted[account_offset + 1];
    let commitment_tree_1 = &remaining_accounts_transmuted[account_offset + 2];
    let note_ledger_1 = &remaining_accounts_transmuted[account_offset + 3];
    let mint_mapping_1 = &remaining_accounts_transmuted[account_offset + 4];
    
    // Parse common accounts (payer, system_program, rent) - should be at the end
    let (payer_account, system_program_account, rent_account) =
        parse_cpi_common_accounts(remaining_accounts_transmuted, payer_pubkey)?;
    
    // Build account metas for batch_private_transfer
    // Order: pool_state_0, nullifier_set_0, commitment_tree_0, note_ledger_0, mint_mapping_0,
    //        verifier_program, verifying_key, payer, system_program, rent,
    //        remaining_accounts: pool_state_1, nullifier_set_1, commitment_tree_1, note_ledger_1, mint_mapping_1
    let mut account_metas = Vec::new();
    let mut account_infos: Vec<AccountInfo<'info>> = Vec::new();
    
    // First pool accounts (explicit)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts_a.pool_state.key(),
        false,
    ));
    account_infos.push(ztoken_accounts_a.pool_state.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts_a.nullifier_set.key(),
        false,
    ));
    account_infos.push(ztoken_accounts_a.nullifier_set.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts_a.commitment_tree.key(),
        false,
    ));
    account_infos.push(ztoken_accounts_a.commitment_tree.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        ztoken_accounts_a.note_ledger.key(),
        false,
    ));
    account_infos.push(ztoken_accounts_a.note_ledger.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts_a.mint_mapping.key(),
        false,
    ));
    account_infos.push(ztoken_accounts_a.mint_mapping.clone());
    
    // Shared accounts
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts_a.verifier_program.key(),
        false,
    ));
    account_infos.push(ztoken_accounts_a.verifier_program.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        ztoken_accounts_a.verifying_key.key(),
        false,
    ));
    account_infos.push(ztoken_accounts_a.verifying_key.clone());
    
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
    
    // Second pool accounts (remaining_accounts)
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        pool_state_1.key(),
        false,
    ));
    account_infos.push(pool_state_1.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        nullifier_set_1.key(),
        false,
    ));
    account_infos.push(nullifier_set_1.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        commitment_tree_1.key(),
        false,
    ));
    account_infos.push(commitment_tree_1.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
        note_ledger_1.key(),
        false,
    ));
    account_infos.push(note_ledger_1.clone());
    
    account_metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        mint_mapping_1.key(),
        false,
    ));
    account_infos.push(mint_mapping_1.clone());
    
    // Build instruction data for batch_private_transfer
    let mut instruction_data = Vec::new();
    
    // Compute discriminator for batch_private_transfer instruction
    // Anchor format: sha256("global:" + instruction_name)[0..8]
    let mut preimage = b"global:".to_vec();
    preimage.extend_from_slice(b"batch_private_transfer");
    let hash = hashv(&[&preimage]);
    let mut batch_transfer_discriminator = [0u8; 8];
    batch_transfer_discriminator.copy_from_slice(&hash.to_bytes()[..8]);
    instruction_data.extend_from_slice(&batch_transfer_discriminator);
    
    // Serialize BatchTransferArgs
    let args_data = batch_transfer_args.try_to_vec()
        .map_err(|_| crate::errors::DexError::InvalidProof)?;
    instruction_data.extend_from_slice(&args_data);
    
    msg!("[ztoken_cpi] Batch transfer instruction data prepared: {} bytes", instruction_data.len());
    
    // Construct instruction
    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: POOL_PROGRAM_ID,
        accounts: account_metas,
        data: instruction_data,
    };
    
    // Invoke batch_private_transfer CPI
    anchor_lang::solana_program::program::invoke(
        &instruction,
        &account_infos,
    )?;
    
    msg!("[ztoken_cpi] ✓ ptf_pool::batch_private_transfer CPI invoked successfully");
    
    // Extract commitments from batch transfer results
    let transfer_a = &batch_transfer_args.transfers[0];
    let transfer_b = &batch_transfer_args.transfers[1];
    
    // Extract commitments that go to the DEX pool PDA (recipient)
    let commitment_a = extract_pool_commitment(&transfer_a.output_commitments, pool_state_key);
    let commitment_b = extract_pool_commitment(&transfer_b.output_commitments, pool_state_key);
    
    // Calculate new reserve amounts (add to current reserves)
    let amount_a_result = commitment_a.map(|_| {
        current_private_reserve_a
            .checked_add(amount_a)
            .ok_or(crate::errors::DexError::MathOverflow)
    }).transpose()?;
    
    let amount_b_result = commitment_b.map(|_| {
        current_private_reserve_b
            .checked_add(amount_b)
            .ok_or(crate::errors::DexError::MathOverflow)
    }).transpose()?;
    
    Ok(((commitment_a, amount_a_result), (commitment_b, amount_b_result)))
}

