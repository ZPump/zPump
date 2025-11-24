# Timelock Action Serialization Error Handling

## Severity: MEDIUM

## Description

The timelock action serialization uses `try_to_vec()` with generic error mapping, which loses error context. If serialization fails, it's unclear why, making debugging difficult.

## Vulnerability Details

### Current Implementation

```332:334:programs/factory/src/lib.rs
let action_bytes = action
    .try_to_vec()
    .map_err(|_| error!(FactoryError::SerializationError))?;
```

Similar pattern at line 580 in `execute_timelock_action`.

### Potential Vulnerabilities

1. **Generic Error**: The error mapping loses the original serialization error, making debugging difficult.

2. **No Size Validation**: The serialized bytes aren't validated for size, which could cause issues if the action is very large.

3. **Serialization Failure**: If serialization fails, it's unclear why, making it hard to fix.

## Exploitation Scenario

```rust
// Scenario: Serialization failure
// 1. Action contains invalid data
// 2. Serialization fails
// 3. Generic error is returned
// 4. Hard to debug what went wrong
// 5. Action cannot be queued
```

## Code References

- Action serialization: Line 332-334
- Similar at line 580

## Mitigation

1. **Preserve error context**:
```rust
let action_bytes = action
    .try_to_vec()
    .map_err(|e| {
        msg!("Failed to serialize timelock action: {:?}", e);
        error!(FactoryError::SerializationError)
    })?;
```

2. **Validate serialized size**:
```rust
// CRITICAL FIX: Validate serialized action size
const MAX_ACTION_SIZE: usize = 10 * 1024; // 10KB max
require!(
    action_bytes.len() <= MAX_ACTION_SIZE,
    FactoryError::ActionTooLarge
);
```

3. **Add logging**:
```rust
// Log action type and size for debugging
msg!("Serialized timelock action: type={:?}, size={}", action_type, action_bytes.len());
```

## Additional Considerations

- Generic error handling makes debugging difficult
- Consider preserving original error information
- Add size validation to prevent DoS
- Document expected action sizes

