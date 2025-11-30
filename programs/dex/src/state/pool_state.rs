use anchor_lang::prelude::*;

#[account]
pub struct PoolState {
    // Token pair identifiers (ordered: token_a < token_b)
    // Both tokens must be zTokens (private tokens)
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    
    // Private reserves (commitment hashes and amounts)
    // These are tracked via the pool PDA's private position in the commitment tree
    // We store both the commitment hash (for privacy) and the amount (for AMM calculations)
    // Note: The pool knows its own reserves, so storing amounts is acceptable
    pub private_reserve_a_commitment: [u8; 32],
    pub private_reserve_a_amount: u64,
    pub private_reserve_b_commitment: [u8; 32],
    pub private_reserve_b_amount: u64,
    
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
        32 + // private_reserve_a_commitment
        8 +  // private_reserve_a_amount
        32 + // private_reserve_b_commitment
        8 +  // private_reserve_b_amount
        32 + // lp_token_mint
        8 +  // total_lp_supply
        8 +  // protocol_fee_accumulator_a
        8 +  // protocol_fee_accumulator_b
        8 +  // lp_fee_accumulator_a
        8 +  // lp_fee_accumulator_b
        8 +  // created_at
        1;   // bump
    
    /// Get reserve amount for token A (always private)
    pub fn get_reserve_a(&self) -> u64 {
        self.private_reserve_a_amount
    }
    
    /// Get reserve amount for token B (always private)
    pub fn get_reserve_b(&self) -> u64 {
        self.private_reserve_b_amount
    }
    
    /// Update private reserve for token A (commitment and amount)
    /// 
    /// Used after zToken operations to track the pool's private position.
    pub fn update_private_reserve_a(&mut self, commitment: [u8; 32], amount: u64) {
        self.private_reserve_a_commitment = commitment;
        self.private_reserve_a_amount = amount;
    }
    
    /// Update private reserve for token B (commitment and amount)
    /// 
    /// Used after zToken operations to track the pool's private position.
    pub fn update_private_reserve_b(&mut self, commitment: [u8; 32], amount: u64) {
        self.private_reserve_b_commitment = commitment;
        self.private_reserve_b_amount = amount;
    }
    
    /// Update private reserve commitment for token A (legacy method, updates amount to 0)
    /// 
    /// DEPRECATED: Use update_private_reserve_a instead
    pub fn update_private_reserve_a_commitment(&mut self, commitment: [u8; 32]) {
        self.private_reserve_a_commitment = commitment;
        // Amount should be updated separately when known
    }
    
    /// Update private reserve commitment for token B (legacy method, updates amount to 0)
    /// 
    /// DEPRECATED: Use update_private_reserve_b instead
    pub fn update_private_reserve_b_commitment(&mut self, commitment: [u8; 32]) {
        self.private_reserve_b_commitment = commitment;
        // Amount should be updated separately when known
    }
    
    /// Add to private reserve A amount (for liquidity additions)
    pub fn add_private_reserve_a(&mut self, amount: u64) -> Result<()> {
        self.private_reserve_a_amount = self.private_reserve_a_amount
            .checked_add(amount)
            .ok_or(crate::errors::DexError::MathOverflow)?;
        Ok(())
    }
    
    /// Add to private reserve B amount (for liquidity additions)
    pub fn add_private_reserve_b(&mut self, amount: u64) -> Result<()> {
        self.private_reserve_b_amount = self.private_reserve_b_amount
            .checked_add(amount)
            .ok_or(crate::errors::DexError::MathOverflow)?;
        Ok(())
    }
    
    /// Subtract from private reserve A amount (for liquidity removals and swaps)
    pub fn sub_private_reserve_a(&mut self, amount: u64) -> Result<()> {
        require!(
            self.private_reserve_a_amount >= amount,
            crate::errors::DexError::InsufficientLiquidity
        );
        self.private_reserve_a_amount = self.private_reserve_a_amount
            .checked_sub(amount)
            .ok_or(crate::errors::DexError::MathOverflow)?;
        Ok(())
    }
    
    /// Subtract from private reserve B amount (for liquidity removals and swaps)
    pub fn sub_private_reserve_b(&mut self, amount: u64) -> Result<()> {
        require!(
            self.private_reserve_b_amount >= amount,
            crate::errors::DexError::InsufficientLiquidity
        );
        self.private_reserve_b_amount = self.private_reserve_b_amount
            .checked_sub(amount)
            .ok_or(crate::errors::DexError::MathOverflow)?;
        Ok(())
    }
    
    /// Get private reserve commitment for token A
    pub fn get_private_reserve_a_commitment(&self) -> Option<[u8; 32]> {
        if self.private_reserve_a_commitment != [0u8; 32] {
            Some(self.private_reserve_a_commitment)
        } else {
            None
        }
    }
    
    /// Get private reserve commitment for token B
    pub fn get_private_reserve_b_commitment(&self) -> Option<[u8; 32]> {
        if self.private_reserve_b_commitment != [0u8; 32] {
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
