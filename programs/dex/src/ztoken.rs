//! zToken operations helper module
//! 
//! Provides utilities for integrating with ptf_pool for zToken shield/transfer operations.
//! 
//! # Architecture
//! 
//! zToken operations in the DEX require:
//! 1. Proof generation (done client-side via ProofClient/RPC service)
//! 2. CPI calls to ptf_pool for shield/transfer operations
//! 3. Multiple accounts from the zToken pool (pool_state, commitment_tree, nullifier_set, etc.)
//! 
//! The pool PDA acts as a "user" in the private pool system, holding private reserves.
//! zTokens NEVER unshield during DEX operations (critical security requirement).
//! 
//! # Operations
//! 
//! - **create_pool with zToken**: Shield initial liquidity from user to pool PDA
//! - **add_liquidity with zToken**: Transfer zTokens from user to pool PDA
//! - **remove_liquidity with zToken**: Transfer zTokens from pool PDA to user
//! - **swap zToken → zToken**: Transfer from user to pool, then pool to user (private transfer both sides)
//! - **swap Public → zToken**: Shield output (public tokens go to pool, zTokens created for user)
//! - **swap zToken → Public**: Transfer from pool to user (NO unshield - pool already holds public reserves)

use anchor_lang::prelude::*;
use ptf_common::addresses::{AddressDeriver, PoolAddresses};

/// Derives all pool-related addresses for a zToken mint
/// 
/// This is used to get all the PDAs needed for ptf_pool CPIs:
/// - pool_state
/// - commitment_tree
/// - nullifier_set
/// - note_ledger
/// - hook_config
/// - hook_whitelist
pub fn derive_ztoken_pool_addresses(
    origin_mint: &Pubkey,
    pool_program_id: &Pubkey,
) -> PoolAddresses {
    PoolAddresses::derive_all(origin_mint, pool_program_id)
}

/// Derives mint mapping PDA for a zToken
/// 
/// The mint mapping contains metadata about the zToken (status, decimals, etc.)
pub fn derive_mint_mapping(
    origin_mint: &Pubkey,
    factory_program_id: &Pubkey,
) -> (Pubkey, u8) {
    AddressDeriver::derive_mint_mapping(origin_mint, factory_program_id)
}

/// Derives vault state PDA for a zToken
/// 
/// The vault holds the public token reserves that back the zTokens
pub fn derive_vault_state(
    origin_mint: &Pubkey,
    vault_program_id: &Pubkey,
) -> (Pubkey, u8) {
    AddressDeriver::derive_vault_state(origin_mint, vault_program_id)
}

/// Derives shield claim PDA for a zToken pool
/// 
/// Used during shield operations to track pending shields
pub fn derive_shield_claim(
    pool_state: &Pubkey,
    pool_program_id: &Pubkey,
) -> (Pubkey, u8) {
    AddressDeriver::derive_shield_claim(pool_state, pool_program_id)
}

// Note: Actual CPI calls to ptf_pool will be implemented in the instruction modules.
// This requires:
// - Client-side proof generation via ProofClient
// - Passing proof data and all required accounts as instruction parameters
// - CPI context setup with proper signer seeds (pool PDA)
// 
// See TODO comments in create_pool.rs, add_liquidity.rs, remove_liquidity.rs, and swap.rs
// for where zToken CPIs need to be implemented.

/// Helper to validate that a mint is a zToken (has a pool state)
/// 
/// This checks if the mint has an active mint mapping in the factory,
/// which indicates it's registered as a zToken.
pub fn validate_ztoken_mint(_origin_mint: &Pubkey) -> Result<()> {
    // TODO: Load mint_mapping and validate status is active
    // For now, we'll assume validation happens at the instruction level
    Ok(())
}

