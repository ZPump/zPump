//! Centralized validation framework for accounts and inputs.

use anchor_lang::prelude::*;
use crate::MAX_BPS;
use super::errors::CommonError;

/// Centralized account validation.
pub struct AccountValidator;

impl AccountValidator {
    /// Validate account ownership with comprehensive checks.
    pub fn validate_ownership(
        account: &AccountInfo,
        expected_owner: &Pubkey,
        _account_name: &str,
    ) -> Result<()> {
        require_keys_eq!(
            *account.owner,
            *expected_owner,
            CommonError::InvalidAccountOwner
        );
        require!(
            account.data_len() >= 8, // Minimum discriminator
            CommonError::AccountDataTooShort
        );
        Ok(())
    }
    
    /// Validate PDA with bump seed.
    pub fn validate_pda(
        account: &AccountInfo,
        seeds: &[&[u8]],
        program_id: &Pubkey,
        expected_bump: u8,
    ) -> Result<()> {
        let (expected_pda, expected_bump_derived) = 
            Pubkey::find_program_address(seeds, program_id);
        require_keys_eq!(
            account.key(),
            expected_pda,
            CommonError::InvalidPDA
        );
        require!(
            expected_bump == expected_bump_derived,
            CommonError::InvalidBump
        );
        Ok(())
    }
    
    /// Validate account data integrity.
    pub fn validate_account_data(
        account: &AccountInfo,
        min_size: usize,
        discriminator: Option<[u8; 8]>,
    ) -> Result<()> {
        let data = account.try_borrow_data()?;
        require!(
            data.len() >= min_size,
            CommonError::AccountDataTooShort
        );
        
        if let Some(disc) = discriminator {
            require!(
                data[0..8] == disc,
                CommonError::InvalidDiscriminator
            );
        }
        
        Ok(())
    }
}

/// Centralized input validation.
pub struct InputValidator;

impl InputValidator {
    /// Validate amount with bounds checking.
    pub fn validate_amount(amount: u64, max: u64) -> Result<()> {
        require!(amount > 0, CommonError::InvalidAmount);
        require!(amount <= max, CommonError::AmountTooLarge);
        Ok(())
    }
    
    /// Validate fee basis points.
    pub fn validate_fee_bps(fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_BPS, CommonError::InvalidFeeBps);
        Ok(())
    }
    
    /// Validate pubkey is not default.
    pub fn validate_pubkey_not_default(pubkey: &Pubkey) -> Result<()> {
        require!(
            *pubkey != Pubkey::default(),
            CommonError::InvalidPubkey
        );
        Ok(())
    }
}

