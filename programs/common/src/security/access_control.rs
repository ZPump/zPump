//! Access control abstraction with multi-sig support and duplicate signer prevention.

use anchor_lang::prelude::*;
use super::errors::CommonError;

/// Access level required for an operation.
#[derive(Clone, Debug)]
pub enum AccessLevel {
    Public,
    Authority,
    MultiSig { threshold: u8, signers: Vec<Pubkey> },
    Timelock { delay: i64 },
    EmergencyPause,
}

/// Access control state for timelock and rate limiting.
pub struct AccessControlState {
    pub clock: Clock,
    pub last_action_time: Option<i64>,
}

/// Centralized access control.
pub struct AccessController;

impl AccessController {
    /// Check if caller has required access.
    pub fn require_access(
        level: AccessLevel,
        caller: &Pubkey,
        authority: &Pubkey,
        remaining_accounts: &[AccountInfo],
        _state: Option<&AccessControlState>,
    ) -> Result<()> {
        match level {
            AccessLevel::Public => Ok(()),
            AccessLevel::Authority => {
                require_keys_eq!(*caller, *authority, CommonError::Unauthorized);
                Ok(())
            }
            AccessLevel::MultiSig { threshold, signers } => {
                Self::check_multisig(threshold, signers, remaining_accounts)
            }
            AccessLevel::Timelock { delay: _ } => {
                // Timelock checking would be implemented here
                // For now, delegate to authority check
                require_keys_eq!(*caller, *authority, CommonError::Unauthorized);
                Ok(())
            }
            AccessLevel::EmergencyPause => {
                // Emergency pause checking would be implemented here
                // For now, delegate to authority check
                require_keys_eq!(*caller, *authority, CommonError::Unauthorized);
                Ok(())
            }
        }
    }
    
    /// Check multi-sig with duplicate signer prevention.
    fn check_multisig(
        threshold: u8,
        signers: Vec<Pubkey>,
        remaining_accounts: &[AccountInfo],
    ) -> Result<()> {
        // CRITICAL FIX: Validate no duplicate signers in configuration
        let mut seen = std::collections::HashSet::new();
        for signer in &signers {
            require!(
                seen.insert(*signer),
                CommonError::DuplicateSigner
            );
        }
        
        // Count signatures, ensuring each signer only counts once
        let mut signatures = 0u8;
        let mut seen_signers = std::collections::HashSet::new();
        for signer_pubkey in &signers {
            if remaining_accounts.iter().any(|acc| {
                acc.key() == *signer_pubkey && acc.is_signer && seen_signers.insert(*signer_pubkey)
            }) {
                signatures = signatures.checked_add(1)
                    .ok_or(CommonError::InsufficientSignatures)?;
            }
        }
        
        require!(
            signatures >= threshold,
            CommonError::InsufficientSignatures
        );
        Ok(())
    }
}

