# Root Expiration Check Uses Saturating Sub

**Severity:** MEDIUM

**Location:** `programs/pool/src/lib.rs:3771-3791`

## Description

The `is_known_root` function uses `saturating_sub` to calculate root age, which means if the timestamp is corrupted or invalid, it will silently saturate to 0 instead of returning an error. This could allow expired roots to be accepted if there's a timestamp issue.

## Code Reference

```rust
pub fn is_known_root(&self, candidate: &[u8; 32]) -> bool {
    // Check current root first (most common case)
    if self.current_root == *candidate {
        return true;
    }
    
    // Check recent roots with expiration
    let clock = Clock::get().ok()?; // Returns None if Clock unavailable
    let current_time = clock.unix_timestamp;
    
    for idx in 0..(self.roots_len as usize) {
        if self.recent_roots[idx] == *candidate {
            // CRITICAL FIX: Check if root has expired
            let root_age = current_time.saturating_sub(self.recent_roots_timestamps[idx]);
            if root_age > Self::ROOT_EXPIRATION_SECONDS {
                return false; // Root expired
            }
            return true;
        }
    }
    false
}
```

## Issue

If `current_time` is less than `recent_roots_timestamps[idx]` (e.g., due to clock manipulation or corrupted state), `saturating_sub` will return 0, making the root appear fresh even though it might be expired.

## Impact

- Expired roots might be accepted if timestamps are corrupted
- Clock manipulation could potentially bypass expiration checks
- Silent failures instead of explicit error handling

## Current Mitigations

- Clock::get() returns None if unavailable, which causes early return
- Current root check doesn't use expiration (always valid)
- Recent roots are checked with expiration

## Recommendation

1. Consider using `checked_sub` and explicitly handling underflow cases
2. Add validation that timestamps are reasonable (not in the future)
3. Log warnings when timestamp anomalies are detected
4. Consider rejecting roots if timestamp is in the future

