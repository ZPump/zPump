//! Common error types for security-related operations.

use anchor_lang::prelude::*;

/// Common security-related errors used across all programs.
#[error_code]
pub enum CommonError {
    // Validation errors
    #[msg("Invalid account owner")]
    InvalidAccountOwner,
    #[msg("Account data too short")]
    AccountDataTooShort,
    #[msg("Invalid PDA")]
    InvalidPDA,
    #[msg("Invalid bump seed")]
    InvalidBump,
    #[msg("Invalid discriminator")]
    InvalidDiscriminator,
    
    // Input errors
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Amount too large")]
    AmountTooLarge,
    #[msg("Invalid fee basis points")]
    InvalidFeeBps,
    #[msg("Invalid pubkey")]
    InvalidPubkey,
    
    // Access control errors
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Insufficient signatures")]
    InsufficientSignatures,
    #[msg("Duplicate signer")]
    DuplicateSigner,
    
    // State errors
    #[msg("Invalid state transition")]
    InvalidStateTransition,
    #[msg("State machine error")]
    StateMachineError,
    
    // Rate limiting errors
    #[msg("Rate limited")]
    RateLimited,
    
    // Integrity errors
    #[msg("Integrity check failed")]
    IntegrityCheckFailed,
    
    // Invariant errors
    #[msg("Invariant breach")]
    InvariantBreach,
    
    // Sanitization errors
    #[msg("Invalid proof")]
    InvalidProof,
    #[msg("Proof too large")]
    ProofTooLarge,
    #[msg("Invalid public inputs")]
    InvalidPublicInputs,
    #[msg("Public inputs too large")]
    PublicInputsTooLarge,
    #[msg("Invalid commitment")]
    InvalidCommitment,
    #[msg("Invalid nullifier")]
    InvalidNullifier,
}

/// Error context for better debugging.
pub struct ErrorContext {
    pub instruction: &'static str,
    pub account: Option<anchor_lang::prelude::Pubkey>,
    pub details: String,
}

impl ErrorContext {
    pub fn new(instruction: &'static str) -> Self {
        Self {
            instruction,
            account: None,
            details: String::new(),
        }
    }
    
    pub fn with_account(mut self, account: anchor_lang::prelude::Pubkey) -> Self {
        self.account = Some(account);
        self
    }
    
    pub fn with_details(mut self, details: String) -> Self {
        self.details = details;
        self
    }
}

