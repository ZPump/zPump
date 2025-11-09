//! Simplified representation of the program-owned vault.

use std::error::Error;
use std::fmt;

use ptf_common::Pubkey;

/// Errors raised by vault operations.
#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    /// Caller is not authorized to release funds from the vault.
    UnauthorizedCaller,
    /// Attempted to withdraw more funds than available.
    InsufficientBalance,
    /// Deposits must be non-zero amounts.
    InvalidDepositAmount,
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            VaultError::UnauthorizedCaller => "unauthorized release caller",
            VaultError::InsufficientBalance => "insufficient vault balance",
            VaultError::InvalidDepositAmount => "deposit amount must be positive",
        };
        write!(f, "{}", message)
    }
}

impl Error for VaultError {}

/// Program state representing custody for a single origin mint.
#[derive(Debug)]
pub struct Vault {
    origin_mint: Pubkey,
    pool_authority: Pubkey,
    balance: u64,
}

impl Vault {
    /// Creates a new vault tied to the provided origin mint and pool authority.
    pub fn new(origin_mint: Pubkey, pool_authority: Pubkey) -> Self {
        Self {
            origin_mint,
            pool_authority,
            balance: 0,
        }
    }

    /// Returns the vault balance.
    pub fn balance(&self) -> u64 {
        self.balance
    }

    /// Returns the associated pool authority.
    pub fn pool_authority(&self) -> Pubkey {
        self.pool_authority
    }

    /// Deposits tokens into the vault.
    pub fn deposit(&mut self, amount: u64) -> Result<(), VaultError> {
        if amount == 0 {
            return Err(VaultError::InvalidDepositAmount);
        }
        self.balance = self.balance.checked_add(amount).expect("overflow");
        Ok(())
    }

    /// Releases tokens to a destination, callable only by the pool authority.
    pub fn release(&mut self, caller: Pubkey, amount: u64) -> Result<(), VaultError> {
        if caller != self.pool_authority {
            return Err(VaultError::UnauthorizedCaller);
        }
        if self.balance < amount {
            return Err(VaultError::InsufficientBalance);
        }
        self.balance -= amount;
        Ok(())
    }

    /// Changes the pool authority (used when governance migrates ownership).
    pub fn set_pool_authority(&mut self, new_authority: Pubkey) {
        self.pool_authority = new_authority;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN_MINT: Pubkey = Pubkey::new([1u8; 32]);
    const POOL_AUTHORITY: Pubkey = Pubkey::new([2u8; 32]);
    const OTHER_AUTHORITY: Pubkey = Pubkey::new([3u8; 32]);

    #[test]
    fn deposit_increases_balance() {
        let mut vault = Vault::new(ORIGIN_MINT, POOL_AUTHORITY);
        vault.deposit(5).expect("deposit");
        assert_eq!(vault.balance(), 5);
    }

    #[test]
    fn zero_deposit_rejected() {
        let mut vault = Vault::new(ORIGIN_MINT, POOL_AUTHORITY);
        let err = vault.deposit(0).expect_err("zero deposit");
        assert_eq!(err, VaultError::InvalidDepositAmount);
    }

    #[test]
    fn release_requires_authority() {
        let mut vault = Vault::new(ORIGIN_MINT, POOL_AUTHORITY);
        vault.deposit(10).expect("deposit");
        let err = vault.release(OTHER_AUTHORITY, 4).expect_err("unauthorized");
        assert_eq!(err, VaultError::UnauthorizedCaller);
        vault
            .release(POOL_AUTHORITY, 4)
            .expect("release authorized");
        assert_eq!(vault.balance(), 6);
    }

    #[test]
    fn release_respects_balance() {
        let mut vault = Vault::new(ORIGIN_MINT, POOL_AUTHORITY);
        vault.deposit(5).expect("deposit");
        let err = vault.release(POOL_AUTHORITY, 6).expect_err("insufficient");
        assert_eq!(err, VaultError::InsufficientBalance);
    }

    #[test]
    fn update_pool_authority() {
        let mut vault = Vault::new(ORIGIN_MINT, POOL_AUTHORITY);
        vault.set_pool_authority(OTHER_AUTHORITY);
        let err = vault.release(POOL_AUTHORITY, 1).expect_err("old authority");
        assert_eq!(err, VaultError::UnauthorizedCaller);
        vault.deposit(2).expect("deposit");
        vault.release(OTHER_AUTHORITY, 1).expect("release new auth");
        assert_eq!(vault.balance(), 1);
    }
}
