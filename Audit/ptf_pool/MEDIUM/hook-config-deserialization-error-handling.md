# Hook Config Deserialization Error Handling

## Severity: MEDIUM

## Description

The hook config is deserialized manually with error handling, but if deserialization fails, the error might not provide enough context, and the account state might be left in an inconsistent state.

## Vulnerability Details

### Current Implementation

```4766:4770:programs/pool/src/lib.rs
// Skip discriminator (first 8 bytes) and deserialize
let mut data_slice = &data[8..];
let cfg_result = HookConfig::try_deserialize(&mut data_slice);
drop(data);
let cfg = cfg_result.map_err(|_| PoolError::HookConfigInvalid)?;
```

### Potential Vulnerabilities

1. **Generic Error**: The error mapping `map_err(|_| PoolError::HookConfigInvalid)` loses the original error information, making debugging difficult.

2. **Incomplete Deserialization**: If deserialization partially succeeds, the account might be in an inconsistent state.

3. **Data Slice Validation**: The code doesn't validate that `data_slice` has enough bytes before deserialization.

4. **Discriminator Validation**: The code skips the discriminator but doesn't validate it matches HookConfig.

## Exploitation Scenario

```rust
// Scenario: Corrupted hook config
// 1. Hook config account is corrupted
// 2. Deserialization fails
// 3. Generic error is returned
// 4. Hard to debug what went wrong
// 5. Account might be left in bad state
```

## Code References

- Hook config deserialization: Lines 4766-4770
- Similar pattern at line 2193

## Mitigation

1. **Validate data length before deserialization**:
```rust
// CRITICAL FIX: Validate data length before deserialization
let data = hook_config_account.try_borrow_data()?;
require!(
    data.len() >= 8 + HookConfig::SPACE,
    PoolError::HookConfigInvalid
);

// Validate discriminator matches HookConfig
let discriminator = &data[0..8];
// Check discriminator matches (if possible)

// Skip discriminator and deserialize
let mut data_slice = &data[8..];
let cfg_result = HookConfig::try_deserialize(&mut data_slice);
drop(data);

// CRITICAL FIX: Provide better error context
let cfg = cfg_result.map_err(|e| {
    msg!("Hook config deserialization failed: {:?}", e);
    PoolError::HookConfigInvalid
})?;
```

2. **Validate deserialization consumed all bytes**:
```rust
// After deserialization, verify all bytes were consumed
require!(
    data_slice.is_empty(),
    PoolError::HookConfigInvalid
);
```

3. **Add integrity validation**:
```rust
// After deserialization, validate the config is internally consistent
cfg.validate_integrity()?;
```

4. **Add logging**:
```rust
// Log deserialization attempts for debugging
msg!("Deserializing hook config, data len: {}", data.len());
```

## Additional Considerations

- Generic error handling makes debugging difficult
- Consider preserving original error information
- Add validation for deserialized data
- Document expected data format

