use anchor_lang::prelude::*;

#[account]
pub struct PoolState {
    // Token pair identifiers (ordered: token_a < token_b)
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    
    // Token type flags
    pub token_a_is_ztoken: bool,
    pub token_b_is_ztoken: bool,
    
    // Public reserves (only used if corresponding token is public)
    pub public_reserve_a: u64,
    pub public_reserve_b: u64,
    
    // Private reserves (commitment hashes, only used if corresponding token is zToken)
    // These are tracked via the pool PDA's private position in the commitment tree
    // We store the amount commitments for tracking purposes
    pub private_reserve_a_commitment: [u8; 32],
    pub private_reserve_b_commitment: [u8; 32],
    
    // LP token information
    pub lp_token_mint: Pubkey,
    pub total_lp_supply: u64,
    
    // Fee accumulators
    pub protocol_fee_accumulator_a: u64,
    pub protocol_fee_accumulator_b: u64,
    pub lp_fee_accumulator_a: u64,
    pub lp_fee_accumulator_b: u64,
    
    // Timestamps
    pub created_at: i64,
    
    // PDA bump seed
    pub bump: u8,
}

impl PoolState {
    pub const LEN: usize = 8 + // discriminator
        32 + // token_a_mint
        32 + // token_b_mint
        1 +  // token_a_is_ztoken
        1 +  // token_b_is_ztoken
        8 +  // public_reserve_a
        8 +  // public_reserve_b
        32 + // private_reserve_a_commitment
        32 + // private_reserve_b_commitment
        32 + // lp_token_mint
        8 +  // total_lp_supply
        8 +  // protocol_fee_accumulator_a
        8 +  // protocol_fee_accumulator_b
        8 +  // lp_fee_accumulator_a
        8 +  // lp_fee_accumulator_b
        8 +  // created_at
        1;   // bump
    
    pub fn get_public_reserve_a(&self) -> u64 {
        if self.token_a_is_ztoken {
            0
        } else {
            self.public_reserve_a
        }
    }
    
    pub fn get_public_reserve_b(&self) -> u64 {
        if self.token_b_is_ztoken {
            0
        } else {
            self.public_reserve_b
        }
    }
    
    /// Update private reserve commitment for token A
    /// 
    /// Used after zToken operations to track the pool's private position.
    pub fn update_private_reserve_a_commitment(&mut self, commitment: [u8; 32]) {
        self.private_reserve_a_commitment = commitment;
    }
    
    /// Update private reserve commitment for token B
    /// 
    /// Used after zToken operations to track the pool's private position.
    pub fn update_private_reserve_b_commitment(&mut self, commitment: [u8; 32]) {
        self.private_reserve_b_commitment = commitment;
    }
    
    /// Get private reserve commitment for token A (returns zero if not zToken)
    pub fn get_private_reserve_a_commitment(&self) -> Option<[u8; 32]> {
        if self.token_a_is_ztoken && self.private_reserve_a_commitment != [0u8; 32] {
            Some(self.private_reserve_a_commitment)
        } else {
            None
        }
    }
    
    /// Get private reserve commitment for token B (returns zero if not zToken)
    pub fn get_private_reserve_b_commitment(&self) -> Option<[u8; 32]> {
        if self.token_b_is_ztoken && self.private_reserve_b_commitment != [0u8; 32] {
            Some(self.private_reserve_b_commitment)
        } else {
            None
        }
    }
}

/// Helper to order two token mints deterministically (token_a < token_b)
pub fn order_token_pair(mint_a: Pubkey, mint_b: Pubkey) -> (Pubkey, Pubkey) {
    if mint_a < mint_b {
        (mint_a, mint_b)
    } else {
        (mint_b, mint_a)
    }
}

/// Seeds for DEX pool state PDA
pub const DEX_POOL_SEED: &[u8] = b"pool";
