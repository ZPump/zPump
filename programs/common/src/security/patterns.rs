//! Defensive programming patterns.

use anchor_lang::prelude::*;

/// Validate then execute pattern.
pub fn validate_then_execute<T>(
    validate: impl Fn() -> Result<()>,
    execute: impl FnOnce() -> Result<T>,
) -> Result<T> {
    // Validate first
    validate()?;
    
    // Then execute
    execute()
}

/// Atomic operation pattern with rollback.
pub fn atomic_operation<T>(
    state: &mut T,
    operation: impl FnOnce(&mut T) -> Result<()>,
) -> Result<()>
where
    T: Clone,
{
    // Save state
    let backup = state.clone();
    
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

