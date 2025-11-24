//! Account data integrity checking.

use anchor_lang::prelude::*;
use sha3::{Digest, Keccak256};
use super::errors::CommonError;

/// Trait for accounts with integrity checking.
pub trait AccountIntegrity {
    fn compute_integrity_hash(&self) -> [u8; 32];
    fn verify_integrity(&self, expected_hash: &[u8; 32]) -> Result<()> {
        let computed = self.compute_integrity_hash();
        require!(
            computed == *expected_hash,
            CommonError::IntegrityCheckFailed
        );
        Ok(())
    }
}

/// Integrity checker.
pub struct IntegrityChecker;

impl IntegrityChecker {
    /// Compute hash of critical account fields.
    pub fn compute_hash<T: AccountIntegrity>(account: &T) -> [u8; 32] {
        account.compute_integrity_hash()
    }
    
    /// Verify account integrity.
    pub fn verify<T: AccountIntegrity>(
        account: &T,
        expected_hash: &[u8; 32],
    ) -> Result<()> {
        account.verify_integrity(expected_hash)
    }
    
    /// Hash multiple fields.
    pub fn hash_fields(fields: &[&[u8]]) -> [u8; 32] {
        let mut hasher = Keccak256::new();
        for field in fields {
            hasher.update(field);
        }
        hasher.finalize().into()
    }
}

