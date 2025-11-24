//! Invariant checking framework.

use anchor_lang::prelude::*;
use std::ops::Sub;
use super::errors::CommonError;

/// Trait for invariants that can be checked.
pub trait Invariant {
    fn check(&self) -> Result<()>;
    fn name() -> &'static str;
}

/// Invariant checker with tolerance support.
pub struct InvariantChecker;

impl InvariantChecker {
    /// Check all invariants.
    pub fn check_all<T: Invariant>(state: &T) -> Result<()> {
        state.check()
    }
    
    /// Check with tolerance.
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

