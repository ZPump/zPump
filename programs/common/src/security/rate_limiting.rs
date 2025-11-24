//! Rate limiting infrastructure.

use anchor_lang::prelude::*;
use super::errors::CommonError;

/// Rate limiter state.
pub struct RateLimiter {
    pub last_action_time: Option<i64>,
    pub action_count: u32,
    pub window_start: i64,
}

/// Rate limit configuration.
pub struct RateLimitConfig {
    pub min_time_between_actions: i64,
    pub max_actions_per_window: u32,
    pub window_duration: i64,
}

impl RateLimiter {
    /// Check rate limit.
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

