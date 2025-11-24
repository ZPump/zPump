//! Event-based security monitoring.

use anchor_lang::prelude::*;

/// Security event type (serialized as u8 for compact on-chain logs).
#[repr(u8)]
#[derive(Clone, Copy, Debug)]
pub enum SecurityEventType {
    AuthorizationAttempt = 0,
    StateTransition = 1,
    InvariantCheck = 2,
    RateLimitHit = 3,
    ValidationFailure = 4,
    AnomalyDetected = 5,
}

/// Security severity level.
#[repr(u8)]
#[derive(Clone, Copy, Debug)]
pub enum SecuritySeverity {
    Low = 0,
    Medium = 1,
    High = 2,
    Critical = 3,
}

/// Security event for monitoring.
#[event]
pub struct SecurityEvent {
    pub event_type: u8,
    pub timestamp: i64,
    pub actor: Pubkey,
    pub details: String,
    pub severity: u8,
}

/// Emit security event for monitoring.
pub fn emit_security_event(
    event_type: SecurityEventType,
    actor: Pubkey,
    details: String,
    severity: SecuritySeverity,
) {
    let Ok(clock) = Clock::get() else {
        return;
    };

    emit!(SecurityEvent {
        event_type: event_type as u8,
        timestamp: clock.unix_timestamp,
        actor,
        details,
        severity: severity as u8,
    });
}

