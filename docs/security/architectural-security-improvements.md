# Architectural Security Improvements

## Overview

This document outlines architectural changes to minimize security risks across all smart contracts. These improvements focus on defense-in-depth, reducing attack surface, and making security issues harder to introduce.

## 1. Centralized Validation Framework

### Current State
- Validation logic is scattered across instructions
- Inconsistent validation patterns
- Duplicate validation code
- Easy to miss validation in new code paths

### Proposed Architecture

```rust
// New module: programs/common/src/validation.rs
pub mod validation {
    use anchor_lang::prelude::*;
    
    /// Centralized account validation
    pub struct AccountValidator;
    
    impl AccountValidator {
        /// Validate account ownership with comprehensive checks
        pub fn validate_ownership(
            account: &AccountInfo,
            expected_owner: &Pubkey,
            account_name: &str,
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
        
        /// Validate PDA with bump seed
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
        
        /// Validate account data integrity
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
    
    /// Centralized input validation
    pub struct InputValidator;
    
    impl InputValidator {
        /// Validate amount with bounds checking
        pub fn validate_amount(amount: u64, max: u64) -> Result<()> {
            require!(amount > 0, CommonError::InvalidAmount);
            require!(amount <= max, CommonError::AmountTooLarge);
            Ok(())
        }
        
        /// Validate fee basis points
        pub fn validate_fee_bps(fee_bps: u16) -> Result<()> {
            require!(fee_bps <= MAX_BPS, CommonError::InvalidFeeBps);
            Ok(())
        }
        
        /// Validate pubkey is not default
        pub fn validate_pubkey_not_default(pubkey: &Pubkey) -> Result<()> {
            require!(
                *pubkey != Pubkey::default(),
                CommonError::InvalidPubkey
            );
            Ok(())
        }
    }
}
```

### Benefits
- **Consistency**: All validation uses same patterns
- **Maintainability**: Fix bugs in one place
- **Auditability**: Easier to review validation logic
- **Reduced Errors**: Less chance of missing validation

## 2. State Machine Enforcement

### Current State
- State transitions validated but not strictly enforced
- Complex state recovery logic
- Potential for invalid state transitions

### Proposed Architecture

```rust
// New module: programs/common/src/state_machine.rs
pub mod state_machine {
    use anchor_lang::prelude::*;
    
    pub trait StateMachine {
        type State: Copy + PartialEq;
        type Event;
        
        /// Get current state
        fn current_state(&self) -> Self::State;
        
        /// Validate state transition
        fn can_transition(&self, from: Self::State, to: Self::State) -> bool;
        
        /// Get valid transitions from current state
        fn valid_transitions(&self) -> Vec<Self::State>;
        
        /// Transition to new state with validation
        fn transition(&mut self, to: Self::State) -> Result<()> {
            let from = self.current_state();
            require!(
                self.can_transition(from, to),
                CommonError::InvalidStateTransition
            );
            self.set_state(to);
            Ok(())
        }
        
        /// Set state (internal)
        fn set_state(&mut self, state: Self::State);
    }
    
    /// Example implementation for ShieldClaim
    impl StateMachine for ShieldClaim {
        type State = u8;
        type Event = ShieldEvent;
        
        fn current_state(&self) -> u8 {
            self.status
        }
        
        fn can_transition(&self, from: u8, to: u8) -> bool {
            // Define valid transitions
            matches!(
                (from, to),
                (STATUS_INACTIVE, STATUS_PENDING_TREE)
                    | (STATUS_PENDING_TREE, STATUS_AWAITING_LEDGER)
                    | (STATUS_AWAITING_LEDGER, STATUS_AWAITING_INVARIANT)
                    | (STATUS_AWAITING_INVARIANT, STATUS_INACTIVE)
                    // ... other valid transitions
            )
        }
        
        fn set_state(&mut self, state: u8) {
            self.status = state;
        }
    }
}
```

### Benefits
- **Strict Enforcement**: Invalid transitions impossible
- **Clear State Model**: Easy to understand valid states
- **Reduced Bugs**: Can't accidentally create invalid states
- **Better Testing**: Can test all valid transitions

## 3. Access Control Abstraction

### Current State
- Authorization checks scattered
- Inconsistent multi-sig handling
- Easy to miss authorization checks

### Proposed Architecture

```rust
// New module: programs/common/src/access_control.rs
pub mod access_control {
    use anchor_lang::prelude::*;
    
    pub enum AccessLevel {
        Public,
        Authority,
        MultiSig { threshold: u8, signers: Vec<Pubkey> },
        Timelock { delay: i64 },
        EmergencyPause,
    }
    
    pub struct AccessController;
    
    impl AccessController {
        /// Check if caller has required access
        pub fn require_access(
            level: AccessLevel,
            caller: &Pubkey,
            authority: &Pubkey,
            remaining_accounts: &[AccountInfo],
            state: &AccessControlState,
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
                AccessLevel::Timelock { delay } => {
                    Self::check_timelock(delay, state)
                }
                AccessLevel::EmergencyPause => {
                    Self::check_emergency_pause(remaining_accounts, state)
                }
            }
        }
        
        fn check_multisig(
            threshold: u8,
            signers: Vec<Pubkey>,
            remaining_accounts: &[AccountInfo],
        ) -> Result<()> {
            // Validate no duplicate signers
            let mut seen = std::collections::HashSet::new();
            for signer in &signers {
                require!(
                    seen.insert(*signer),
                    CommonError::DuplicateSigner
                );
            }
            
            // Count signatures
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
}
```

### Benefits
- **Consistent Authorization**: Same logic everywhere
- **Multi-Sig Security**: Prevents duplicate signer attacks
- **Easy Updates**: Update authorization logic in one place
- **Clear Intent**: Access requirements explicit

## 4. Input Sanitization Layer

### Current State
- Input validation happens inline
- Some inputs not validated
- Inconsistent validation patterns

### Proposed Architecture

```rust
// New module: programs/common/src/sanitization.rs
pub mod sanitization {
    use anchor_lang::prelude::*;
    
    pub struct InputSanitizer;
    
    impl InputSanitizer {
        /// Sanitize and validate proof
        pub fn sanitize_proof(proof: &[u8], max_size: usize) -> Result<&[u8]> {
            require!(
                proof.len() <= max_size,
                CommonError::ProofTooLarge
            );
            require!(!proof.is_empty(), CommonError::InvalidProof);
            Ok(proof)
        }
        
        /// Sanitize and validate public inputs
        pub fn sanitize_public_inputs(
            inputs: &[u8],
            max_size: usize,
        ) -> Result<&[u8]> {
            require!(
                inputs.len() <= max_size,
                CommonError::PublicInputsTooLarge
            );
            require!(!inputs.is_empty(), CommonError::InvalidPublicInputs);
            Ok(inputs)
        }
        
        /// Sanitize commitment (validate format)
        pub fn sanitize_commitment(commitment: &[u8; 32]) -> Result<()> {
            // Reject all zeros
            require!(
                *commitment != [0u8; 32],
                CommonError::InvalidCommitment
            );
            // Reject all ones (invalid field element)
            require!(
                *commitment != [0xFFu8; 32],
                CommonError::InvalidCommitment
            );
            Ok(())
        }
        
        /// Sanitize nullifier
        pub fn sanitize_nullifier(nullifier: &[u8; 32]) -> Result<()> {
            // Same validation as commitment
            Self::sanitize_commitment(nullifier)
        }
    }
}
```

### Benefits
- **Consistent Validation**: All inputs validated the same way
- **Early Rejection**: Invalid inputs rejected before processing
- **Reduced Attack Surface**: Fewer code paths with invalid data
- **Easier Testing**: Can test sanitization independently

## 5. Invariant Checking Framework

### Current State
- Invariant checks scattered
- Some checks optional (feature flags)
- Inconsistent tolerance handling

### Proposed Architecture

```rust
// New module: programs/common/src/invariants.rs
pub mod invariants {
    use anchor_lang::prelude::*;
    
    pub trait Invariant {
        fn check(&self) -> Result<()>;
        fn name() -> &'static str;
    }
    
    pub struct InvariantChecker;
    
    impl InvariantChecker {
        /// Check all invariants
        pub fn check_all<T: Invariant>(state: &T) -> Result<()> {
            state.check()
        }
        
        /// Check with tolerance
        pub fn check_with_tolerance<T>(
            expected: T,
            actual: T,
            tolerance: T,
        ) -> Result<()>
        where
            T: PartialOrd + Sub<Output = T> + Copy,
        {
            let diff = if actual > expected {
                actual - expected
            } else {
                expected - actual
            };
            require!(diff <= tolerance, CommonError::InvariantBreach);
            Ok(())
        }
    }
    
    /// Example: Supply Invariant
    pub struct SupplyInvariant {
        pub vault_balance: u128,
        pub twin_supply: u128,
        pub live_value: u128,
        pub protocol_fees: u128,
    }
    
    impl Invariant for SupplyInvariant {
        fn name() -> &'static str {
            "SupplyInvariant"
        }
        
        fn check(&self) -> Result<()> {
            let expected = self.twin_supply
                .checked_add(self.live_value)
                .ok_or(CommonError::AmountOverflow)?
                .checked_add(self.protocol_fees)
                .ok_or(CommonError::AmountOverflow)?;
            
            InvariantChecker::check_with_tolerance(
                expected,
                self.vault_balance,
                1u128, // 1 lamport tolerance
            )
        }
    }
}
```

### Benefits
- **Standardized Checks**: All invariants checked consistently
- **Easy to Add**: New invariants easy to add
- **Better Testing**: Can test invariants independently
- **Clear Failures**: Invariant name in error message

## 6. Rate Limiting Infrastructure

### Current State
- Some rate limiting (factory timelock)
- Inconsistent implementation
- No global rate limiting

### Proposed Architecture

```rust
// New module: programs/common/src/rate_limiting.rs
pub mod rate_limiting {
    use anchor_lang::prelude::*;
    
    pub struct RateLimiter {
        pub last_action_time: Option<i64>,
        pub action_count: u32,
        pub window_start: i64,
    }
    
    pub struct RateLimitConfig {
        pub min_time_between_actions: i64,
        pub max_actions_per_window: u32,
        pub window_duration: i64,
    }
    
    impl RateLimiter {
        pub fn check_rate_limit(
            &mut self,
            config: &RateLimitConfig,
            clock: &Clock,
        ) -> Result<()> {
            let current_time = clock.unix_timestamp;
            
            // Reset window if expired
            if current_time > self.window_start + config.window_duration {
                self.action_count = 0;
                self.window_start = current_time;
            }
            
            // Check minimum time between actions
            if let Some(last_time) = self.last_action_time {
                require!(
                    current_time >= last_time + config.min_time_between_actions,
                    CommonError::RateLimited
                );
            }
            
            // Check actions per window
            require!(
                self.action_count < config.max_actions_per_window,
                CommonError::RateLimited
            );
            
            // Update state
            self.last_action_time = Some(current_time);
            self.action_count = self.action_count
                .checked_add(1)
                .ok_or(CommonError::RateLimited)?;
            
            Ok(())
        }
    }
}
```

### Benefits
- **DoS Protection**: Prevents rapid-fire attacks
- **Consistent Implementation**: Same rate limiting everywhere
- **Configurable**: Different limits for different operations
- **Easy to Add**: Add rate limiting to any instruction

## 7. Event-Based Security Monitoring

### Current State
- Some events emitted
- Not all security-relevant actions logged
- Inconsistent event structure

### Proposed Architecture

```rust
// Enhanced event system
#[event]
pub struct SecurityEvent {
    pub event_type: SecurityEventType,
    pub timestamp: i64,
    pub actor: Pubkey,
    pub details: String,
    pub severity: SecuritySeverity,
}

pub enum SecurityEventType {
    AuthorizationAttempt,
    StateTransition,
    InvariantCheck,
    RateLimitHit,
    ValidationFailure,
    AnomalyDetected,
}

pub enum SecuritySeverity {
    Low,
    Medium,
    High,
    Critical,
}

// Emit security events for monitoring
pub fn emit_security_event(
    event_type: SecurityEventType,
    actor: Pubkey,
    details: String,
    severity: SecuritySeverity,
) {
    emit!(SecurityEvent {
        event_type,
        timestamp: Clock::get().unwrap().unix_timestamp,
        actor,
        details,
        severity,
    });
}
```

### Benefits
- **Security Monitoring**: Track all security-relevant events
- **Anomaly Detection**: Identify suspicious patterns
- **Audit Trail**: Complete record of security events
- **Alerting**: Can alert on high-severity events

## 8. Defensive Programming Patterns

### Current State
- Some defensive patterns used
- Inconsistent application
- Some code paths lack defense

### Proposed Patterns

```rust
// Pattern 1: Always validate before use
pub fn safe_operation(data: &[u8]) -> Result<()> {
    // Always validate first
    require!(data.len() >= MIN_SIZE, CommonError::DataTooShort);
    
    // Then use
    process_data(data)
}

// Pattern 2: Fail secure (default deny)
pub fn check_permission(user: &Pubkey, resource: &Pubkey) -> Result<()> {
    // Default to deny
    let mut allowed = false;
    
    // Only allow if explicitly permitted
    if is_authorized(user, resource)? {
        allowed = true;
    }
    
    require!(allowed, CommonError::Unauthorized);
    Ok(())
}

// Pattern 3: Validate-Then-Execute
pub fn execute_with_validation<T>(
    validate: impl Fn() -> Result<()>,
    execute: impl FnOnce() -> Result<T>,
) -> Result<T> {
    // Validate first
    validate()?;
    
    // Then execute
    execute()
}

// Pattern 4: Atomic Operations
pub fn atomic_operation(
    state: &mut State,
    operation: impl FnOnce(&mut State) -> Result<()>,
) -> Result<()> {
    // Save state
    let backup = *state;
    
    // Execute operation
    match operation(state) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Rollback on error
            *state = backup;
            Err(e)
        }
    }
}
```

### Benefits
- **Consistent Patterns**: Same defensive patterns everywhere
- **Reduced Errors**: Harder to introduce security bugs
- **Better Code Review**: Reviewers know what to look for
- **Easier Testing**: Patterns are testable

## 9. Account Data Integrity

### Current State
- Some integrity checks
- Not all accounts validated
- Inconsistent validation

### Proposed Architecture

```rust
// New module: programs/common/src/integrity.rs
pub mod integrity {
    use anchor_lang::prelude::*;
    use sha3::{Digest, Keccak256};
    
    pub trait AccountIntegrity {
        fn compute_integrity_hash(&self) -> [u8; 32];
        fn verify_integrity(&self, expected_hash: &[u8; 32]) -> Result<()>;
    }
    
    pub struct IntegrityChecker;
    
    impl IntegrityChecker {
        /// Compute hash of critical account fields
        pub fn compute_hash<T: AccountIntegrity>(account: &T) -> [u8; 32] {
            account.compute_integrity_hash()
        }
        
        /// Verify account integrity
        pub fn verify<T: AccountIntegrity>(
            account: &T,
            expected_hash: &[u8; 32],
        ) -> Result<()> {
            account.verify_integrity(expected_hash)
        }
        
        /// Hash multiple fields
        pub fn hash_fields(fields: &[&[u8]]) -> [u8; 32] {
            let mut hasher = Keccak256::new();
            for field in fields {
                hasher.update(field);
            }
            hasher.finalize().into()
        }
    }
}
```

### Benefits
- **Data Integrity**: Detect corruption early
- **Tamper Detection**: Detect unauthorized modifications
- **Consistent Validation**: Same integrity checks everywhere
- **Better Debugging**: Know when data is corrupted

## 10. Error Handling Standardization

### Current State
- Inconsistent error handling
- Some errors too generic
- Error context sometimes lost

### Proposed Architecture

```rust
// Enhanced error system
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
    
    // Input errors
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Amount too large")]
    AmountTooLarge,
    #[msg("Invalid fee basis points")]
    InvalidFeeBps,
    
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
}

// Error context helper
pub struct ErrorContext {
    pub instruction: &'static str,
    pub account: Option<Pubkey>,
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
    
    pub fn with_account(mut self, account: Pubkey) -> Self {
        self.account = Some(account);
        self
    }
    
    pub fn with_details(mut self, details: String) -> Self {
        self.details = details;
        self
    }
}
```

### Benefits
- **Consistent Errors**: Same errors everywhere
- **Better Debugging**: More context in errors
- **Easier Monitoring**: Can track error patterns
- **Better UX**: Users get clearer error messages

## Implementation Priority

### Phase 1: High Impact, Low Risk
1. **Centralized Validation Framework** - Reduces bugs, easy to implement
2. **Input Sanitization Layer** - Prevents many attack vectors
3. **Error Handling Standardization** - Improves debugging

### Phase 2: Medium Impact, Medium Risk
4. **State Machine Enforcement** - Requires refactoring but high security value
5. **Access Control Abstraction** - Fixes multi-sig duplicate signer issue
6. **Defensive Programming Patterns** - Reduces future bugs

### Phase 3: High Impact, Higher Risk
7. **Invariant Checking Framework** - Requires careful testing
8. **Rate Limiting Infrastructure** - May affect legitimate users
9. **Account Data Integrity** - Requires migration for existing accounts
10. **Event-Based Security Monitoring** - Adds compute cost

## Migration Strategy

1. **Create Common Module**: Add `programs/common/src/security/` module
2. **Gradual Migration**: Migrate one instruction at a time
3. **Test Thoroughly**: Test each migration before next
4. **Monitor**: Watch for any issues after migration
5. **Document**: Update documentation as patterns are adopted

## Success Metrics

- **Reduced Audit Findings**: Fewer security issues in future audits
- **Faster Development**: New features easier to secure
- **Better Testing**: Security patterns easier to test
- **Improved Monitoring**: Better visibility into security events

## Conclusion

These architectural improvements provide defense-in-depth by:
- **Reducing Attack Surface**: Fewer code paths with security issues
- **Increasing Consistency**: Same patterns everywhere
- **Improving Maintainability**: Fix bugs in one place
- **Enhancing Monitoring**: Better visibility into security events
- **Facilitating Testing**: Security patterns easier to test

The key is gradual adoption, starting with high-impact, low-risk changes, then moving to more complex improvements.

