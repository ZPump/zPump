//! State machine enforcement framework.

use anchor_lang::prelude::*;
use super::errors::CommonError;

/// Trait for state machines with enforced transitions.
pub trait StateMachine {
    type State: Copy + PartialEq;
    
    /// Get current state.
    fn current_state(&self) -> Self::State;
    
    /// Validate state transition.
    fn can_transition(&self, from: Self::State, to: Self::State) -> bool;
    
    /// Transition to new state with validation.
    fn transition(&mut self, to: Self::State) -> Result<()> {
        let from = self.current_state();
        require!(
            self.can_transition(from, to),
            CommonError::InvalidStateTransition
        );
        self.set_state(to);
        Ok(())
    }
    
    /// Set state (internal).
    fn set_state(&mut self, state: Self::State);
}


