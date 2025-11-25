# Zero Timelock Allows Instant Factory Actions

**Status:** ⚠️ NEW ISSUE

**Severity:** HIGH

**Location:** `programs/factory/src/lib.rs:31-47` (initialize_factory)

## Description

The factory initialization explicitly allows a timelock duration of `0` seconds to bypass the minimum 24-hour delay. Deploying the program with a zero timelock permanently disables the governance delay for all privileged factory actions, including mint configuration, verifier updates, and emergency pauses. Once initialized with `timelock_seconds = 0`, there is no enforcement mechanism preventing immediate execution of queued actions, defeating the timelock design entirely.

## Code Reference

### initialize_factory (lines 31-47):
```rust
// CRITICAL FIX: Enforce minimum timelock (allow 0 for test/devnet initialization)
// In production, timelock should be at least 24 hours, but for devnet/testing we allow 0
if timelock_seconds > 0 {
    require!(
        timelock_seconds >= MIN_TIMELOCK_SECONDS,
        FactoryError::TimelockTooShort
    );
}
```

## Issue

Allowing a zero timelock at initialization lets a malicious deployer permanently remove any enforced delay on privileged operations. Since the timelock duration is stored in state and never tightened later, all subsequent governance actions can execute immediately without the intended 24-hour buffer, enabling rapid, unreviewed upgrades or parameter changes that can compromise funds.

## Impact

- **Attack scenario**: Deploy the factory with `timelock_seconds = 0`, then immediately queue and execute sensitive actions (e.g., swapping verifier program IDs or changing fees) without any delay or community review.
- **Potential loss**: Complete governance bypass enabling malicious configuration updates that redirect assets or disable safeguards.
- **Likelihood**: Medium—anyone controlling deployment parameters can set the timelock to zero on mainnet.

## Attack Scenario

1. A deployer initializes the factory with `timelock_seconds = 0`.
2. Immediately queue and execute high-privilege actions (e.g., changing verifier program ID or fee schedules).
3. Users have no delay to react, allowing instant malicious reconfiguration.

## Current Mitigations

None. The code intentionally permits zero timelocks with no environment gating or subsequent enforcement.

## Recommendation

Enforce the minimum timelock unconditionally in production builds or add an explicit safety flag to allow zero only in controlled test environments. Reject initialization when `timelock_seconds < MIN_TIMELOCK_SECONDS` unless a compile-time `dev` feature is enabled.

### Suggested Fix:
```rust
// Always enforce minimum timelock unless explicitly compiled for local development
#[cfg(not(feature = "dev"))]
require!(
    timelock_seconds >= MIN_TIMELOCK_SECONDS,
    FactoryError::TimelockTooShort,
);

#[cfg(feature = "dev")]
require!(timelock_seconds >= 0, FactoryError::TimelockTooShort);
```

## Related Code

- `programs/factory/src/lib.rs:31-47` - Timelock validation during factory initialization
- `programs/factory/src/lib.rs:555-600` - Timelock duration stored in `FactoryState` and reused by action queue
