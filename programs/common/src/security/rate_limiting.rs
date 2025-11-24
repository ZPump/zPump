//! Rate limiting infrastructure shared across programs.

use anchor_lang::prelude::*;

use super::errors::CommonError;

/// Serialized rate-limiter state stored inside on-chain accounts.
#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
)]
pub struct RateLimiterState {
    /// Last unix timestamp when the action was performed (0 = never).
    pub last_action_time: i64,
    /// Start of the rolling window that counts burst actions (0 = unset).
    pub window_start: i64,
    /// Number of actions that occurred inside the current window.
    pub action_count: u32,
}

impl RateLimiterState {
    /// Serialized size helper for account space calculations.
    pub const SIZE: usize = 8 + 8 + 4;

    /// Reset the limiter state (used when configuration changes).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Enforce the configured limits for the current clock time.
    pub fn check(&mut self, config: &RateLimitConfig, clock: &Clock) -> Result<()> {
        let current_time = clock.unix_timestamp;

        if self.window_start == 0 {
            self.window_start = current_time;
        }

        // Reset burst counters if the rolling window expired.
        if current_time.saturating_sub(self.window_start) >= config.window_duration {
            self.window_start = current_time;
            self.action_count = 0;
        }

        if self.last_action_time != 0 {
            require!(
                current_time.saturating_sub(self.last_action_time)
                    >= config.min_time_between_actions,
                CommonError::RateLimited
            );
        }

        require!(
            self.action_count < config.max_actions_per_window,
            CommonError::RateLimited
        );

        self.last_action_time = current_time;
        self.action_count = self
            .action_count
            .checked_add(1)
            .ok_or(CommonError::RateLimited)?;

        Ok(())
    }
}

/// Rate limit configuration shared between instructions.
#[derive(Clone, Copy)]
pub struct RateLimitConfig {
    pub min_time_between_actions: i64,
    pub max_actions_per_window: u32,
    pub window_duration: i64,
}


