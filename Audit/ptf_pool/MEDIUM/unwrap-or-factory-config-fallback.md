# Unwrap_or Factory Config Fallback

## Severity: MEDIUM

## Description

The code uses `unwrap_or_else(|| factory_state_account_info.clone())` when finding factory_config account. If factory_config is not found, it falls back to using factory_state_account_info, which might not be the correct account structure and could cause issues.

## Vulnerability Details

### Current Implementation

```2130:2134:programs/pool/src/lib.rs
// The factory instruction will check if factory_config exists and handle None gracefully
let factory_config_account_info = ctx.remaining_accounts.iter()
    .find(|acc| acc.key() == factory_config_pda)
    .cloned()
    .unwrap_or_else(|| factory_state_account_info.clone());
```

### Potential Vulnerabilities

1. **Wrong Account Type**: If factory_config is not found, the code uses factory_state_account_info instead. These are different account types with different structures. The factory program might expect factory_config but receive factory_state, causing validation failures or incorrect behavior.

2. **Silent Failure**: The fallback happens silently without logging, which could mask configuration issues.

3. **Account Structure Mismatch**: factory_config and factory_state have different account structures. Using the wrong one could cause:
   - Deserialization errors
   - Incorrect data reads
   - Validation failures

## Exploitation Scenario

```rust
// Scenario: Factory config missing
// 1. factory_config account is not provided in remaining_accounts
// 2. Code falls back to factory_state_account_info
// 3. Factory program receives factory_state instead of factory_config
// 4. Factory program tries to deserialize as FactoryConfig
// 5. Deserialization fails or reads wrong data
// 6. Operation fails or behaves incorrectly
```

## Code References

- Line 2131-2134: Factory config fallback logic

## Mitigation

1. **Fail explicitly if factory_config is missing**:
```rust
let factory_config_account_info = ctx.remaining_accounts.iter()
    .find(|acc| acc.key() == factory_config_pda)
    .ok_or(PoolError::FactoryConfigMissing)?
    .clone();
```

2. **Add error type**:
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("Factory config account missing")]
    FactoryConfigMissing,
}
```

3. **Make factory_config optional but validate**:
```rust
let factory_config_account_info = ctx.remaining_accounts.iter()
    .find(|acc| acc.key() == factory_config_pda)
    .cloned();
    
// If factory_config is provided, validate it
if let Some(config_info) = &factory_config_account_info {
    // Validate account structure
    require!(
        config_info.owner == &ptf_factory::ID,
        PoolError::FactoryConfigInvalid
    );
}
```

4. **Add logging** when fallback is used:
```rust
let factory_config_account_info = ctx.remaining_accounts.iter()
    .find(|acc| acc.key() == factory_config_pda)
    .cloned()
    .unwrap_or_else(|| {
        msg!("WARNING: factory_config not found, using factory_state fallback");
        factory_state_account_info.clone()
    });
```

## Additional Considerations

- The factory program might handle None gracefully, but using wrong account type is risky
- Consider whether factory_config should be required or optional
- Document the fallback behavior if it's intentional

