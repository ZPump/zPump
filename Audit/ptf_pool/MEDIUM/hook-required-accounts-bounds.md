# Hook Required Accounts Bounds Check

## Severity: MEDIUM

## Description

The hook configuration allows up to `MAX_REQUIRED_ACCOUNTS` (8) required accounts, but there's no validation that the `required_accounts_len` field matches the actual number of non-zero entries in the `required_accounts` array.

## Vulnerability Details

### Current Implementation

```650:658:programs/pool/src/lib.rs
hook_config.required_accounts_len = 0;
zero_hook_required_accounts(&mut hook_config.required_accounts);
for (idx, key) in args.required_accounts.iter().enumerate() {
    require!(
        idx < HookConfig::MAX_REQUIRED_ACCOUNTS,
        PoolError::TooManyHookAccounts
    );
    hook_config.required_accounts[idx] = key.to_bytes();
    hook_config.required_accounts_len += 1;
}
```

The `required_accounts_len` is incremented for each account, but if the array is manually modified or corrupted, the length might not match the actual number of valid accounts.

### Potential Vulnerabilities

1. **Length Mismatch**: If `required_accounts_len` doesn't match the actual number of non-zero accounts, validation might:
   - Skip required accounts (if length is too small)
   - Require non-existent accounts (if length is too large)
   - Cause validation failures

2. **Array Corruption**: If the array is corrupted and contains zero pubkeys, the length field might not reflect this.

3. **Manual Modification**: If someone can modify the account data directly, they could set `required_accounts_len` to a wrong value.

## Exploitation Scenario

```rust
// Scenario: Length mismatch
// 1. required_accounts_len is set to 5
// 2. But only 3 accounts in array are non-zero
// 3. Validation checks for 5 accounts
// 4. Fails or behaves unexpectedly

// Scenario: Array corruption
// 1. Array contains zero pubkeys in middle
// 2. required_accounts_len doesn't account for this
// 3. Validation is incorrect
```

## Code References

- Hook config setup: Lines 650-658
- `required_accounts_len` field in HookConfig
- `MAX_REQUIRED_ACCOUNTS`: Line 5068

## Mitigation

1. **Validate length matches array**:
```rust
// When reading hook config, validate length matches actual accounts
pub fn validate_required_accounts(&self) -> Result<()> {
    let actual_count = self.required_accounts
        .iter()
        .take(self.required_accounts_len as usize)
        .filter(|bytes| {
            let pubkey = Pubkey::new_from_array(*bytes);
            pubkey != Pubkey::default()
        })
        .count();
    
    require!(
        actual_count == self.required_accounts_len as usize,
        PoolError::HookConfigCorrupt
    );
    Ok(())
}
```

2. **Recompute length on read**:
```rust
// When using required_accounts, recompute length from array
// Don't trust stored length field
let actual_len = hook_config.required_accounts
    .iter()
    .position(|bytes| {
        Pubkey::new_from_array(*bytes) == Pubkey::default()
    })
    .unwrap_or(hook_config.required_accounts_len as usize);
```

3. **Validate on configuration**:
```rust
// When setting required accounts, validate all are non-zero
for key in &args.required_accounts {
    require!(
        *key != Pubkey::default(),
        PoolError::InvalidHookAccount
    );
}
```

4. **Add integrity check**:
```rust
// Add integrity validation function
impl HookConfig {
    pub fn validate_integrity(&self) -> Result<()> {
        require!(
            self.required_accounts_len as usize <= Self::MAX_REQUIRED_ACCOUNTS,
            PoolError::HookConfigCorrupt
        );
        
        // Validate all accounts up to len are non-zero
        for i in 0..self.required_accounts_len as usize {
            let pubkey = Pubkey::new_from_array(self.required_accounts[i]);
            require!(
                pubkey != Pubkey::default(),
                PoolError::HookConfigCorrupt
            );
        }
        
        // Validate all accounts after len are zero
        for i in self.required_accounts_len as usize..Self::MAX_REQUIRED_ACCOUNTS {
            let pubkey = Pubkey::new_from_array(self.required_accounts[i]);
            require!(
                pubkey == Pubkey::default(),
                PoolError::HookConfigCorrupt
            );
        }
        
        Ok(())
    }
}
```

## Additional Considerations

- The current implementation is mostly safe, but validation is good defense in depth
- Consider using Vec instead of fixed array if dynamic sizing is needed
- Add tests for edge cases (zero accounts, corrupted length, etc.)

