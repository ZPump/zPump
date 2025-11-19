# Security Audit: ptf_factory (Post-Fix)

## Overview
The `ptf_factory` program manages mint mappings, creates twin mints, and handles timelock actions. Previous critical issues have been addressed with hash collision fixes, size limits, and cleanup functions.

## Security Vulnerabilities

### 1. **CRITICAL: Action Hash Validation Missing Salt in Execute**
**Severity:** CRITICAL  
**Location:** `execute_timelock_action()` function (lines 396-410)

**Description:**
The action hash recomputed during execution (lines 401-405) does NOT include the salt, but the hash stored during queuing (line 243) DOES include salt. This means:
- Queue: `hash(factory || salt || action || execute_after)`
- Execute: `hash(factory || action || execute_after)` (MISSING SALT!)

This mismatch will cause ALL execution attempts to fail, permanently locking all timelock actions.

**Impact:**
- All timelock actions become unexecutable
- Permanent DoS on factory operations
- Requires emergency upgrade

**Recommendation:**
Include salt in hash recomputation:

```rust
let expected_hash = hashv(&[
    state.key().as_ref(),
    &entry.salt, // ADD THIS LINE
    &action_bytes,
    &entry.execute_after.to_le_bytes(),
]);
```

### 2. **HIGH: No Rate Limiting on Timelock Actions**
**Severity:** HIGH  
**Location:** `queue_timelock_action()` function (lines 224-311)

**Description:**
While there's a maximum pending actions check (50), there's no rate limiting on how quickly actions can be queued. An attacker could rapidly fill the queue with 50 actions and then cancel them, effectively blocking legitimate operations.

**Impact:**
- Temporary DoS by filling pending action queue
- Legitimate operations blocked
- Requires waiting for timelock expiration or cleanup

**Recommendation:**
Add rate limiting per authority or minimum time between actions:

```rust
// Store last_action_time in FactoryState
require!(
    clock.unix_timestamp >= state.last_action_time + MIN_TIME_BETWEEN_ACTIONS,
    FactoryError::ActionRateLimitExceeded
);
state.last_action_time = clock.unix_timestamp;
```

### 3. **HIGH: Timelock Entry Can Be Cleaned Up While Still Valid**
**Severity:** HIGH  
**Location:** `cleanup_timelock_action()` function (lines 509-536)

**Description:**
The cleanup function only checks if 30 days have passed since `execute_after`, but doesn't verify the entry hasn't been executed or canceled. While `require!(!entry.executed)` exists, the cleanup sets `entry.executed = true` and `entry.canceled = true` even if the entry was never executed but is still within valid execution window.

**Impact:**
- Valid actions could be prematurely cleaned up
- Loss of ability to execute legitimate timelock actions
- State inconsistency

**Recommendation:**
Only allow cleanup of entries that are truly stale (past execute_after + grace period) AND not canceled/executed:

```rust
require!(!entry.executed && !entry.canceled, FactoryError::TimelockConsumed);
require!(
    clock.unix_timestamp >= entry.execute_after.checked_add(TIMELOCK_STALE_GRACE_SECONDS)
        .ok_or(FactoryError::TimelockOverflow)?,
    FactoryError::TimelockNotExpired
);
```

### 4. **MEDIUM: Mint PTKN Doesn't Validate Pool Authority Is Signer in Context**
**Severity:** MEDIUM  
**Location:** `mint_ptkn()` function (lines 538-610)

**Description:**
The function checks `pool_authority.is_signer` but doesn't verify that the pool_authority provided in the accounts context is actually the signer. This relies on Anchor's constraint, but explicit validation would be clearer.

**Impact:**
- Potential confusion if accounts are misordered
- Relies on Anchor constraints rather than explicit checks

**Recommendation:**
Add explicit signer validation in the accounts struct constraint or in the instruction body.

### 5. **LOW: No Maximum Size Limit on Pending Action Hashes Vector**
**Severity:** LOW  
**Location:** `FactoryState` struct (line 817)

**Description:**
While `MAX_PENDING_ACTIONS` limits additions, the vector itself could theoretically grow if removals fail or are skipped. The space calculation accounts for 50 entries, but if the vector somehow exceeds this, account reallocation could fail.

**Impact:**
- Theoretical account size issues
- Very low probability

**Recommendation:**
Add explicit bounds checking when removing from vector to ensure it never exceeds MAX_PENDING_ACTIONS.

