# Mitigation: Lock State Not Released on CPI Failure

## Severity: MEDIUM (HIGH priority for reliability)
## Contract: ptf_vault
## Issue ID: 12

## Problem Description

The reentrancy lock (`vault_state.locked = true`) is set before CPI calls but only released on successful completion. If the token transfer CPI fails, the lock remains set, permanently DoS'ing the vault.

**Current Code:**
```rust
vault_state.locked = true;
token_interface::transfer(cpi_ctx, amount)?; // If this fails, lock stays true
vault_state.locked = false;
```

## Security Impact

1. **Permanent DoS** - If token transfer fails, vault becomes permanently locked
2. **Funds become inaccessible** - Cannot deposit or release tokens
3. **Requires manual intervention** - Needs program upgrade or admin action

## Mitigation

Use a guard struct with Drop trait to ensure lock is always released:

```rust
struct LockGuard<'a> {
    vault_state: &'a mut VaultState,
}

impl<'a> LockGuard<'a> {
    fn new(vault_state: &'a mut VaultState) -> Self {
        vault_state.locked = true;
        Self { vault_state }
    }
}

impl<'a> Drop for LockGuard<'a> {
    fn drop(&mut self) {
        self.vault_state.locked = false;
    }
}

// Usage:
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let mut vault_state = ctx.accounts.vault_state.load_mut()?;
    let _guard = LockGuard::new(&mut vault_state);
    
    // CPI call - if it fails, guard's drop will release lock
    token_interface::transfer(cpi_ctx, amount)?;
    
    // Guard drops here, releasing lock
    Ok(())
}
```

## Alternative: Manual Try-Finally Pattern

If guard struct is too complex, use explicit error handling:

```rust
vault_state.locked = true;
let result = token_interface::transfer(cpi_ctx, amount);
vault_state.locked = false; // Always release
result?; // Propagate error after releasing lock
```

## Testing

1. Test normal deposit/release flow - should work as before
2. Test with failing CPI call - lock should be released
3. Test multiple operations after failure - should not be permanently locked

## References

- Issue location: `programs/vault/src/lib.rs:28-113`
- Lock field: `VaultState.locked`

