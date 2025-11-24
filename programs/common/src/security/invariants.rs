//! Invariant checking framework.

use anchor_lang::prelude::*;
use std::ops::Sub;

use super::errors::CommonError;

/// Trait for invariants that can be checked.
pub trait Invariant {
    /// Unique, human-readable name for debugging/logging.
    fn name(&self) -> &'static str;
    /// Execute the invariant check.
    fn check(&self) -> Result<()>;
}

/// Invariant checker with tolerance support.
pub struct InvariantChecker;

impl InvariantChecker {
    /// Check a collection of invariants, short-circuiting on the first failure.
    pub fn check_all(invariants: &[&dyn Invariant]) -> Result<()> {
        for invariant in invariants {
            if let Err(err) = invariant.check() {
                msg!("Invariant {} failed: {:?}", invariant.name(), err);
                return Err(err);
            }
        }
        Ok(())
    }
    
    /// Helper to compare expected vs. actual values with tolerance.
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

