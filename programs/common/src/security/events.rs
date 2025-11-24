//! Event-based security monitoring.

use anchor_lang::prelude::*;

/// Security event type.
#[derive(Clone, Debug)]
pub enum SecurityEventType {
    AuthorizationAttempt,
    StateTransition,
    InvariantCheck,
    RateLimitHit,
    ValidationFailure,
    AnomalyDetected,
}

/// Security severity level.
#[derive(Clone, Debug)]
pub enum SecuritySeverity {
    Low,
    Medium,
    High,
    Critical,
}

/// Security event for monitoring.
#[event]
pub struct SecurityEvent {
    pub event_type: u8, // SecurityEventType as u8
    pub timestamp: i64,
    pub actor: Pubkey,
    pub details: String,
    pub severity: u8, // SecuritySeverity as u8
}

/// Emit security event for monitoring.
pub fn emit_security_event(
    event_type: SecurityEventType,
    actor: Pubkey,
    details: String,
    severity: SecuritySeverity,
) {
    let clock = match Clock::get() {
        Ok(c) => c,
        Err(_) => return, // Skip if Clock unavailable
    };
    
    emit!(SecurityEvent {
        event_type: match event_type {
            SecurityEventType::AuthorizationAttempt => 0,
            SecurityEventType::StateTransition => 1,
            SecurityEventType::InvariantCheck => 2,
            SecurityEventType::RateLimitHit => 3,
            SecurityEventType::ValidationFailure => 4,
            SecurityEventType::AnomalyDetected => 5,
        },
        timestamp: clock.unix_timestamp,
        actor,
        details,
        severity: match severity {
            SecuritySeverity::Low => 0,
            SecuritySeverity::Medium => 1,
            SecuritySeverity::High => 2,
            SecuritySeverity::Critical => 3,
        },
    });
}

