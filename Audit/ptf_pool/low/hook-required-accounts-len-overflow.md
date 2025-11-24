# Hook Required Accounts Length Overflow Risk

**Severity:** LOW

**Location:** `programs/pool/src/lib.rs:903-910`

## Description

The `configure_hooks` function increments `required_accounts_len` in a loop without checking if it would overflow. While the loop is bounded by `MAX_REQUIRED_ACCOUNTS` (8), if `required_accounts_len` is already at a high value (e.g., 255), incrementing it could wrap around to 0.

## Code Reference

```rust
hook_config.required_accounts_len = 0;
zero_hook_required_accounts(&mut hook_config.required_accounts);
for (idx, key) in args.required_accounts.iter().enumerate() {
    require!(
        idx < HookConfig::MAX_REQUIRED_ACCOUNTS,
        PoolError::TooManyHookAccounts
    );
    hook_config.required_accounts[idx] = key.to_bytes();
    hook_config.required_accounts_len += 1;  // Could overflow if already at 255
}
```

## Issue

1. **Overflow risk**: If `required_accounts_len` is somehow set to 255 (u8::MAX), then `+= 1` would wrap to 0, causing incorrect length tracking.

2. **No validation**: There's no check that `required_accounts_len` is within expected bounds before incrementing.

3. **State corruption**: If `required_accounts_len` is corrupted, the `required_keys()` iterator could return incorrect results.

## Impact

- Low impact since `required_accounts_len` is reset to 0 at the start of the function
- If state is corrupted, could lead to incorrect hook account validation
- Could allow more or fewer accounts than intended to be used in hooks

## Attack Scenario

1. Attacker finds a way to corrupt `required_accounts_len` to 255
2. Calls `configure_hooks` with 8 accounts
3. `required_accounts_len` wraps from 255 to 0, then increments to 8
4. Actually works correctly in this case, but demonstrates the overflow risk

## Current Mitigations

- `required_accounts_len` is reset to 0 at the start of `configure_hooks`
- Loop is bounded by `MAX_REQUIRED_ACCOUNTS` (8)
- However, there's no explicit validation that `required_accounts_len` is reasonable

## Recommendation

1. **Add explicit bounds validation:**
   ```rust
   hook_config.required_accounts_len = 0;
   // ...
   for (idx, key) in args.required_accounts.iter().enumerate() {
       require!(
           idx < HookConfig::MAX_REQUIRED_ACCOUNTS,
           PoolError::TooManyHookAccounts
       );
       hook_config.required_accounts[idx] = key.to_bytes();
       // CRITICAL FIX: Use checked_add to prevent overflow
       hook_config.required_accounts_len = hook_config.required_accounts_len
           .checked_add(1)
           .ok_or(PoolError::TooManyHookAccounts)?;
   }
   ```

2. **Add validation in `required_keys()` method:**
   ```rust
   pub fn required_keys(&self) -> impl Iterator<Item = Pubkey> + '_ {
       // CRITICAL FIX: Cap to MAX_REQUIRED_ACCOUNTS to prevent out-of-bounds
       let max_len = core::cmp::min(self.required_accounts_len as usize, Self::MAX_REQUIRED_ACCOUNTS);
       self.required_accounts
           .iter()
           .take(max_len)
           .map(|bytes| Pubkey::new_from_array(*bytes))
   }
   ```

## Related Issues

- Similar to `roots_len` bounds checking issue
- Part of defensive programming to prevent state corruption

