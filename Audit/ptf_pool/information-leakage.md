# Information Leakage Through Logs and Events

## Severity: MEDIUM

## Description

The pool program emits detailed log messages and events that could leak sensitive information about internal state, making it easier for attackers to understand the system and plan attacks.

## Vulnerability Details

### Current Implementation

The code includes extensive logging:
- `msg!` statements throughout the code (e.g., lines 501, 508, 514, 516, 659, 675-676)
- Detailed error messages with hex-encoded values
- Events that expose internal state

### Potential Vulnerabilities

1. **Root Information Leakage**: Logs expose current roots, old roots, and root mismatches, which could help attackers understand tree state.

2. **Nullifier Information**: Error messages might leak information about nullifier reuse attempts.

3. **Commitment Information**: Logs expose commitments and commitment mismatches.

4. **State Information**: Detailed logs expose internal state transitions and values.

5. **Timing Information**: Log timing could reveal information about operation duration and system performance.

6. **Error Details**: Detailed error messages could help attackers understand validation logic and find bypasses.

7. **Account Information**: Logs expose account keys, which could be used for tracking or analysis.

## Exploitation Scenario

```rust
// Scenario 1: Root information gathering
// 1. Attacker monitors logs for root values
// 2. Attacker builds map of valid roots over time
// 3. Attacker identifies patterns or finds old valid roots
// 4. Attacker uses information to craft attacks

// Scenario 2: Validation logic discovery
// 1. Attacker sends malformed transactions
// 2. Error messages reveal validation logic
// 3. Attacker learns how to bypass checks
// 4. Attacker crafts successful attack

// Scenario 3: State analysis
// 1. Attacker monitors events and logs
// 2. Attacker builds model of internal state
// 3. Attacker identifies vulnerabilities
// 4. Attacker exploits discovered vulnerabilities
```

## Code References

- Logging in shield: Lines 501, 508, 514, 516, 659, 675-676, 695, 902-906
- Root mismatch logging: Lines 835-839, 1473-1477
- Public input mismatch logging: Lines 3533-3538, 3557-3569, 3589-3593, 3915-3920, 3926-3931
- Event emissions: Multiple `emit!` statements throughout

## Mitigation

1. **Reduce Logging in Production**: Remove or reduce detailed logging in production builds.

2. **Sanitize Error Messages**: Remove sensitive information from error messages exposed to users.

3. **Hash Sensitive Values**: Hash sensitive values before logging (e.g., hash roots instead of logging full values).

4. **Log Levels**: Implement log levels and disable detailed logging in production.

5. **Event Sanitization**: Sanitize events to remove sensitive information.

6. **Error Message Generalization**: Use generic error messages that don't reveal internal state.

7. **Selective Logging**: Only log information necessary for debugging, not full state dumps.

8. **Log Access Control**: Restrict access to detailed logs to authorized personnel only.

## Recommended Code Changes

```rust
// Feature flag for detailed logging
#[cfg(feature = "verbose-logging")]
macro_rules! verbose_msg {
    ($($arg:tt)*) => {
        msg!($($arg)*);
    };
}

#[cfg(not(feature = "verbose-logging"))]
macro_rules! verbose_msg {
    ($($arg:tt)*) => {
        // No-op in production
    };
}

// Hash sensitive values before logging
fn hash_for_logging(value: &[u8; 32]) -> String {
    let hash = hashv(&[value]);
    format!("{}...", hex::encode(&hash.to_bytes()[..8]))
}

// Sanitized logging
msg!(
    "shield: root mismatch - proof old_root={} pool_state.current_root={}",
    hash_for_logging(&old_root_bytes),
    hash_for_logging(&pool_state.current_root)
);

// Generic error messages
// Instead of:
return err!(PoolError::RootMismatch);

// Use generic message that doesn't leak details
// (Error code already provides enough information)

// Event sanitization
emit!(PTFShield {
    mint: pool_state.origin_mint,
    // Don't include sensitive commitment values
    // commitment: hash_for_logging(&commitment_bytes),
    amount: args.amount, // Amount is public anyway
});
```

