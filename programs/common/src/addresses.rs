//! Centralized address derivation utilities for all program-derived addresses (PDAs).
//!
//! This module provides a single source of truth for deriving all PDAs used across
//! the zPump protocol. Programs can use these functions to derive addresses internally
//! from minimal inputs (originMint, wallet, etc.), eliminating the need for lookup tables.

use anchor_lang::prelude::*;
use crate::seeds;
use crate::security::errors::CommonError;

/// Centralized address derivation utilities.
pub struct AddressDeriver;

impl AddressDeriver {
    // ============================================================================
    // Pool-related PDAs
    // ============================================================================
    
    /// Derives the pool state PDA for a given origin mint.
    /// 
    /// Seeds: `[b"pool", origin_mint]`
    /// Program: pool_program_id
    pub fn derive_pool_state(
        origin_mint: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::POOL, origin_mint.as_ref()],
            pool_program_id,
        )
    }
    
    /// Derives the commitment tree PDA for a given origin mint.
    /// 
    /// Seeds: `[b"tree", origin_mint]`
    /// Program: pool_program_id
    pub fn derive_commitment_tree(
        origin_mint: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::TREE, origin_mint.as_ref()],
            pool_program_id,
        )
    }
    
    /// Derives the nullifier set PDA for a given origin mint.
    /// 
    /// Seeds: `[b"nulls", origin_mint]`
    /// Program: pool_program_id
    pub fn derive_nullifier_set(
        origin_mint: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::NULLIFIERS, origin_mint.as_ref()],
            pool_program_id,
        )
    }
    
    /// Derives the note ledger PDA for a given origin mint.
    /// 
    /// Seeds: `[b"notes", origin_mint]`
    /// Program: pool_program_id
    pub fn derive_note_ledger(
        origin_mint: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::NOTES, origin_mint.as_ref()],
            pool_program_id,
        )
    }
    
    /// Derives the hook config PDA for a given origin mint.
    /// 
    /// Seeds: `[b"hooks", origin_mint]`
    /// Program: pool_program_id
    pub fn derive_hook_config(
        origin_mint: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::HOOKS, origin_mint.as_ref()],
            pool_program_id,
        )
    }
    
    /// Derives the hook whitelist PDA for a given origin mint.
    /// 
    /// Seeds: `[b"hook-whitelist", origin_mint]`
    /// Program: pool_program_id
    pub fn derive_hook_whitelist(
        origin_mint: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"hook-whitelist", origin_mint.as_ref()],
            pool_program_id,
        )
    }
    
    /// Derives the shield claim PDA for a given pool state.
    /// 
    /// Seeds: `[b"claim", pool_state]`
    /// Program: pool_program_id
    pub fn derive_shield_claim(
        pool_state: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::CLAIM, pool_state.as_ref()],
            pool_program_id,
        )
    }
    
    /// Derives the allowance account PDA for a given pool, owner, and spender.
    /// 
    /// Seeds: `[b"allow", pool, owner, spender]`
    /// Program: pool_program_id
    pub fn derive_allowance_account(
        pool: &Pubkey,
        owner: &Pubkey,
        spender: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::ALLOWANCE, pool.as_ref(), owner.as_ref(), spender.as_ref()],
            pool_program_id,
        )
    }
    
    // ============================================================================
    // Vault-related PDAs
    // ============================================================================
    
    /// Derives the vault state PDA for a given origin mint.
    /// 
    /// Seeds: `[b"vault", origin_mint]`
    /// Program: vault_program_id
    pub fn derive_vault_state(
        origin_mint: &Pubkey,
        vault_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::VAULT, origin_mint.as_ref()],
            vault_program_id,
        )
    }
    
    // ============================================================================
    // Factory-related PDAs
    // ============================================================================
    
    /// Derives the mint mapping PDA for a given origin mint.
    /// 
    /// Seeds: `[b"map", origin_mint]`
    /// Program: factory_program_id
    pub fn derive_mint_mapping(
        origin_mint: &Pubkey,
        factory_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::MINT_MAPPING, origin_mint.as_ref()],
            factory_program_id,
        )
    }
    
    /// Derives the factory state PDA.
    /// 
    /// Seeds: `[b"factory", factory_program_id]`
    /// Program: factory_program_id
    pub fn derive_factory_state(
        factory_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::FACTORY, factory_program_id.as_ref()],
            factory_program_id,
        )
    }
    
    /// Derives the factory config PDA for a given factory state.
    /// 
    /// Seeds: `[b"factory-config", factory_state]`
    /// Program: factory_program_id
    pub fn derive_factory_config(
        factory_state: &Pubkey,
        factory_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"factory-config", factory_state.as_ref()],
            factory_program_id,
        )
    }
    
    // ============================================================================
    // Verifier-related PDAs
    // ============================================================================
    
    /// Derives the verifying key PDA for a given circuit tag and version.
    /// 
    /// Seeds: `[b"vk", circuit_tag, version]`
    /// Program: verifier_program_id
    pub fn derive_verifying_key(
        circuit_tag: &[u8; 32],
        version: u8,
        verifier_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[seeds::VERIFIER, circuit_tag.as_ref(), &[version]],
            verifier_program_id,
        )
    }
    
    // ============================================================================
    // Validation helpers
    // ============================================================================
    
    /// Validates that a provided account matches the expected derived PDA.
    /// 
    /// Returns an error if the account key doesn't match the expected PDA
    /// or if the bump doesn't match.
    pub fn validate_pda_match<'info>(
        account: &AccountInfo<'info>,
        expected_pda: &Pubkey,
        expected_bump: u8,
    ) -> Result<()> {
        require_keys_eq!(
            account.key(),
            *expected_pda,
            CommonError::InvalidPDA
        );
        Ok(())
    }
}

/// Collection of all pool-related addresses derived from an origin mint.
#[derive(Clone, Debug)]
pub struct PoolAddresses {
    pub pool_state: Pubkey,
    pub pool_state_bump: u8,
    pub commitment_tree: Pubkey,
    pub commitment_tree_bump: u8,
    pub nullifier_set: Pubkey,
    pub nullifier_set_bump: u8,
    pub note_ledger: Pubkey,
    pub note_ledger_bump: u8,
    pub hook_config: Pubkey,
    pub hook_config_bump: u8,
    pub hook_whitelist: Pubkey,
    pub hook_whitelist_bump: u8,
}

impl PoolAddresses {
    /// Derives all pool-related addresses from an origin mint.
    pub fn derive_all(
        origin_mint: &Pubkey,
        pool_program_id: &Pubkey,
    ) -> Self {
        let (pool_state, pool_state_bump) = AddressDeriver::derive_pool_state(origin_mint, pool_program_id);
        let (commitment_tree, commitment_tree_bump) = AddressDeriver::derive_commitment_tree(origin_mint, pool_program_id);
        let (nullifier_set, nullifier_set_bump) = AddressDeriver::derive_nullifier_set(origin_mint, pool_program_id);
        let (note_ledger, note_ledger_bump) = AddressDeriver::derive_note_ledger(origin_mint, pool_program_id);
        let (hook_config, hook_config_bump) = AddressDeriver::derive_hook_config(origin_mint, pool_program_id);
        let (hook_whitelist, hook_whitelist_bump) = AddressDeriver::derive_hook_whitelist(origin_mint, pool_program_id);
        
        Self {
            pool_state,
            pool_state_bump,
            commitment_tree,
            commitment_tree_bump,
            nullifier_set,
            nullifier_set_bump,
            note_ledger,
            note_ledger_bump,
            hook_config,
            hook_config_bump,
            hook_whitelist,
            hook_whitelist_bump,
        }
    }
}

