# Timelock Bypass and Manipulation

## Severity: HIGH

## Description

The factory program implements a timelock system for governance actions. While there are several security measures in place, there are potential vulnerabilities that could allow bypassing or manipulating the timelock mechanism.

## Vulnerability Details

### Current Implementation

The timelock system includes:
- `queue_timelock_action`: Queues an action with a timelock
- `execute_timelock_action`: Executes after timelock expires
- `cancel_timelock_action`: Cancels a pending action
- Hash verification to prevent tampering
- Rate limiting to prevent queue flooding

### Potential Vulnerabilities

1. **Hash Collision**: While unlikely, if two different actions produce the same hash, one could be executed in place of another.

2. **Salt Reuse**: The salt is included in the hash, but if salts are predictable or reused, hash uniqueness could be compromised.

3. **Timelock Time Manipulation**: If the clock can be manipulated or if there's a timezone/clock sync issue, timelocks could be bypassed.

4. **Action Serialization**: If action serialization is not deterministic or can be manipulated, the hash could be different between queue and execute.

5. **Rate Limiting Bypass**: The rate limiting (60 seconds between actions) could potentially be bypassed if multiple authorities queue actions simultaneously.

6. **Sequence Number Overflow**: The sequence number could overflow, potentially causing issues with PDA derivation.

7. **Pending Actions Limit**: The MAX_PENDING_ACTIONS limit (50) could be reached, preventing new actions from being queued (DoS).

## Exploitation Scenario

```rust
// Scenario 1: Hash collision
// 1. Attacker finds two different actions that hash to the same value
// 2. Attacker queues Action A (benign)
// 3. Attacker executes Action B (malicious) using Action A's hash
// 4. Malicious action executes without proper timelock

// Scenario 2: Salt manipulation
// 1. Attacker predicts or reuses salt values
// 2. Attacker can precompute hashes for malicious actions
// 3. Attacker queues action with known hash
// 4. Attacker executes different action with same hash

// Scenario 3: Clock manipulation
// 1. If validator clock can be manipulated (unlikely but possible)
// 2. Timelock expiration could be accelerated
// 3. Actions could execute before intended time

// Scenario 4: Rate limiting bypass
// 1. Attacker controls multiple authorities
// 2. Each authority queues actions simultaneously
// 3. Rate limiting only applies per authority, not globally
// 4. Queue could be flooded despite rate limiting
```

## Code References

- Timelock queue: `queue_timelock_action` (lines 227-331)
- Timelock execute: `execute_timelock_action` (lines 405-506)
- Hash computation: Lines 262-267, 422-427
- Rate limiting: Lines 237-250
- Sequence management: Lines 294-306

## Mitigation

1. **Stronger Hash Function**: Use a cryptographically secure hash function (Keccak256 is already used, which is good). Consider adding additional entropy.

2. **Random Salt Generation**: Ensure salts are cryptographically random and never reused. Consider using a nonce or counter to ensure uniqueness.

3. **Clock Validation**: Add validation to ensure clock values are reasonable and not manipulated. Consider using slot-based timelocks in addition to timestamp-based.

4. **Deterministic Serialization**: Ensure action serialization is completely deterministic. Use canonical serialization formats.

5. **Global Rate Limiting**: Implement global rate limiting in addition to per-authority rate limiting to prevent coordinated attacks.

6. **Sequence Number Safeguards**: Add checks for sequence number overflow and implement wraparound handling if needed.

7. **Pending Actions Management**: Implement a mechanism to clean up old/stale pending actions to prevent DoS from reaching the limit.

8. **Action Expiration**: Add expiration to queued actions so they can't be executed indefinitely far in the future.

## Recommended Code Changes

```rust
// Enhanced hash computation with additional entropy
fn compute_action_hash(
    factory: &Pubkey,
    salt: [u8; 32],
    action: &TimelockAction,
    execute_after: i64,
    sequence: u64, // Include sequence for additional uniqueness
) -> Result<[u8; 32]> {
    let action_bytes = action
        .try_to_vec()
        .map_err(|_| error!(FactoryError::SerializationError))?;
    
    // Include sequence for additional entropy
    let hash = hashv(&[
        factory.as_ref(),
        &salt,
        &action_bytes,
        &execute_after.to_le_bytes(),
        &sequence.to_le_bytes(), // Additional entropy
    ]);
    
    Ok(hash.to_bytes())
}

// Global rate limiting
pub struct FactoryState {
    // ... existing fields ...
    pub last_global_action_time: i64, // Global rate limiting
}

// In queue_timelock_action
// Check global rate limit
if state.last_global_action_time > 0 {
    require!(
        clock.unix_timestamp >= state.last_global_action_time + FactoryState::MIN_TIME_BETWEEN_ACTIONS,
        FactoryError::GlobalActionRateLimitExceeded
    );
}
state.last_global_action_time = clock.unix_timestamp;

// Action expiration
pub struct TimelockEntry {
    // ... existing fields ...
    pub expires_at: Option<i64>, // Optional expiration
}

// In execute_timelock_action
if let Some(expires_at) = entry.expires_at {
    require!(
        clock.unix_timestamp < expires_at,
        FactoryError::ActionExpired
    );
}
```

