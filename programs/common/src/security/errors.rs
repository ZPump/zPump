//! Common error types and standardized error handling for security operations.

use anchor_lang::prelude::*;

/// Common security-related errors used across all programs.
/// 
/// This enum provides a standardized set of error codes and messages
/// that should be used consistently across all programs. While each
/// program maintains its own error enum (required by Anchor), they
/// should map to these common patterns for consistency.
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
    #[msg("Account data corrupt")]
    AccountDataCorrupt,
    #[msg("Account size mismatch")]
    AccountSizeMismatch,
    #[msg("Data length mismatch")]
    DataLengthMismatch,
    
    // Input errors
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Amount too large")]
    AmountTooLarge,
    #[msg("Amount overflow")]
    AmountOverflow,
    #[msg("Invalid fee basis points")]
    InvalidFeeBps,
    #[msg("Invalid pubkey")]
    InvalidPubkey,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid decimals")]
    InvalidDecimals,
    #[msg("Invalid destination")]
    InvalidDestination,
    
    // Access control errors
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Insufficient signatures")]
    InsufficientSignatures,
    #[msg("Duplicate signer")]
    DuplicateSigner,
    #[msg("Invalid authority")]
    InvalidAuthority,
    
    // State errors
    #[msg("Invalid state transition")]
    InvalidStateTransition,
    #[msg("State machine error")]
    StateMachineError,
    #[msg("Already initialized")]
    AlreadyInitialized,
    #[msg("Already executed")]
    AlreadyExecuted,
    #[msg("Already canceled")]
    AlreadyCanceled,
    #[msg("Change canceled")]
    ChangeCanceled,
    
    // Rate limiting errors
    #[msg("Rate limited")]
    RateLimited,
    #[msg("Action rate limit exceeded")]
    ActionRateLimitExceeded,
    #[msg("Global action rate limit exceeded")]
    GlobalActionRateLimitExceeded,
    
    // Integrity errors
    #[msg("Integrity check failed")]
    IntegrityCheckFailed,
    #[msg("Hash mismatch")]
    HashMismatch,
    #[msg("Stale proposal")]
    StaleProposal,
    #[msg("Authority mismatch")]
    AuthorityMismatch,
    
    // Invariant errors
    #[msg("Invariant breach")]
    InvariantBreach,
    
    // Sanitization errors
    #[msg("Invalid proof")]
    InvalidProof,
    #[msg("Proof too large")]
    ProofTooLarge,
    #[msg("Invalid proof format")]
    InvalidProofFormat,
    #[msg("Invalid public inputs")]
    InvalidPublicInputs,
    #[msg("Public inputs too large")]
    PublicInputsTooLarge,
    #[msg("Public input mismatch")]
    PublicInputMismatch,
    #[msg("Invalid commitment")]
    InvalidCommitment,
    #[msg("Invalid nullifier")]
    InvalidNullifier,
    #[msg("Nullifier reuse")]
    NullifierReuse,
    
    // Timelock errors
    #[msg("Timelock overflow")]
    TimelockOverflow,
    #[msg("Timelock not ready")]
    TimelockNotReady,
    #[msg("Timelock not expired")]
    TimelockNotExpired,
    #[msg("Timelock too short")]
    TimelockTooShort,
    #[msg("Change expired")]
    ChangeExpired,
    #[msg("Change not expired")]
    ChangeNotExpired,
    
    // Sequence/overflow errors
    #[msg("Sequence overflow")]
    SequenceOverflow,
    
    // Reentrancy errors
    #[msg("Reentrancy detected")]
    ReentrancyDetected,
    
    // Insufficient balance/liability errors
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Insufficient fees")]
    InsufficientFees,
}

/// Error context for better debugging and standardized error reporting.
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

/// Standardized error message constants for consistency across programs.
/// 
/// Each program should use these message strings (or equivalent) in their
/// error enums to ensure consistent error handling on the client side.
pub mod error_messages {
    // Validation errors
    pub const INVALID_ACCOUNT_OWNER: &str = "Invalid account owner";
    pub const ACCOUNT_DATA_TOO_SHORT: &str = "Account data too short";
    pub const INVALID_PDA: &str = "Invalid PDA";
    pub const INVALID_BUMP: &str = "Invalid bump seed";
    pub const INVALID_DISCRIMINATOR: &str = "Invalid discriminator";
    pub const ACCOUNT_DATA_CORRUPT: &str = "Account data corrupt";
    
    // Input errors
    pub const INVALID_AMOUNT: &str = "Invalid amount";
    pub const AMOUNT_TOO_LARGE: &str = "Amount too large";
    pub const AMOUNT_OVERFLOW: &str = "Amount overflow";
    pub const INVALID_FEE_BPS: &str = "Invalid fee basis points";
    pub const INVALID_PUBKEY: &str = "Invalid pubkey";
    pub const INVALID_MINT: &str = "Invalid mint";
    
    // Access control errors
    pub const UNAUTHORIZED: &str = "Unauthorized";
    pub const UNAUTHORIZED_CALLER: &str = "Unauthorized caller";
    pub const INSUFFICIENT_SIGNATURES: &str = "Insufficient signatures";
    pub const DUPLICATE_SIGNER: &str = "Duplicate signer";
    pub const INVALID_AUTHORITY: &str = "Invalid authority";
    
    // State errors
    pub const INVALID_STATE_TRANSITION: &str = "Invalid state transition";
    pub const ALREADY_INITIALIZED: &str = "Already initialized";
    pub const ALREADY_EXECUTED: &str = "Already executed";
    pub const ALREADY_CANCELED: &str = "Already canceled";
    pub const CHANGE_CANCELED: &str = "Change canceled";
    
    // Rate limiting errors
    pub const RATE_LIMITED: &str = "Rate limited";
    pub const ACTION_RATE_LIMIT_EXCEEDED: &str = "Action rate limit exceeded";
    
    // Integrity errors
    pub const INTEGRITY_CHECK_FAILED: &str = "Integrity check failed";
    pub const HASH_MISMATCH: &str = "Hash mismatch";
    pub const STALE_PROPOSAL: &str = "Stale proposal";
    pub const AUTHORITY_MISMATCH: &str = "Authority mismatch";
    
    // Invariant errors
    pub const INVARIANT_BREACH: &str = "Invariant breach";
    
    // Sanitization errors
    pub const INVALID_PROOF: &str = "Invalid proof";
    pub const PROOF_TOO_LARGE: &str = "Proof too large";
    pub const INVALID_PUBLIC_INPUTS: &str = "Invalid public inputs";
    pub const PUBLIC_INPUTS_TOO_LARGE: &str = "Public inputs too large";
    pub const NULLIFIER_REUSE: &str = "Nullifier reuse";
    
    // Timelock errors
    pub const TIMELOCK_OVERFLOW: &str = "Timelock overflow";
    pub const TIMELOCK_NOT_READY: &str = "Timelock not ready";
    pub const CHANGE_EXPIRED: &str = "Change expired";
    
    // Sequence/overflow errors
    pub const SEQUENCE_OVERFLOW: &str = "Sequence overflow";
    
    // Reentrancy errors
    pub const REENTRANCY_DETECTED: &str = "Reentrancy detected";
    
    // Insufficient balance/liability errors
    pub const INSUFFICIENT_BALANCE: &str = "Insufficient balance";
    pub const INSUFFICIENT_LIQUIDITY: &str = "Insufficient liquidity";
}

/// Helper trait for converting program-specific errors to common error patterns.
/// 
/// This trait allows programs to implement standardized error conversion
/// for better client-side error handling.
pub trait ToCommonError {
    /// Returns the common error category this error belongs to.
    fn to_common_error_category(&self) -> Option<CommonError>;
    
    /// Returns a standardized error message.
    fn to_standard_message(&self) -> &'static str;
}

/// Standardized error handling patterns.
/// 
/// These functions provide consistent error handling across all programs.
pub mod error_handling {
    use super::*;
    
    /// Validates that an amount is within valid bounds.
    /// Returns a standardized error if validation fails.
    pub fn validate_amount(amount: u64, max_amount: u64) -> Result<()> {
        require!(amount > 0, CommonError::InvalidAmount);
        require!(amount <= max_amount, CommonError::AmountTooLarge);
        Ok(())
    }
    
    /// Validates that fee basis points are within valid range (0-10000).
    pub fn validate_fee_bps(fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 10000, CommonError::InvalidFeeBps);
        Ok(())
    }
    
    /// Validates that a sequence number can be incremented without overflow.
    pub fn validate_sequence_increment(sequence: u64) -> Result<u64> {
        sequence
            .checked_add(1)
            .ok_or(CommonError::SequenceOverflow.into())
    }
    
    /// Validates that a timelock duration can be added without overflow.
    pub fn validate_timelock_addition(
        current_time: i64,
        duration: i64,
    ) -> Result<i64> {
        current_time
            .checked_add(duration)
            .ok_or(CommonError::TimelockOverflow.into())
    }
}

