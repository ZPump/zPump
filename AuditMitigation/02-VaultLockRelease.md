# Mitigation: Lock State Not Released on CPI Failure

## Severity: MEDIUM (HIGH priority for reliability)
## Contract: ptf_vault
## Issue ID: 2 (Remaining)

## Problem Description

The reentrancy lock (`vault_state.locked = true`) is set before CPI calls but only released on successful completion. If the token transfer CPI fails (insufficient balance, token program error, network issue, etc.), the lock remains set, permanently DoS'ing the vault.

## Security Impact

1. **Permanent DoS** - If token transfer fails, vault becomes unusable
2. **Funds become inaccessible** - Cannot deposit or release tokens
3. **Requires manual intervention** - Need program upgrade or admin recovery

## Current Code Issue

```rust
// deposit() function
vault_state.locked = true;  // Lock set
token_interface::transfer(cpi_ctx, amount)?;  // If this fails, lock stays true
vault_state.locked = false;  // Only reached on success
```

Same issue in `release()` function.

## Mitigation

Always release lock, even on error:

```rust
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidDepositAmount);

    let vault_state = &mut ctx.accounts.vault_state;
    
    // REENTRANCY GUARD: Check and set lock before any external calls
    require!(!vault_state.locked, VaultError::ReentrancyDetected);
    vault_state.locked = true;
    
    // CRITICAL FIX: Always release lock, even on error
    let result = (|| -> Result<()> {
        require_keys_eq!(
            ctx.accounts.vault_token_account.mint,
            vault_state.origin_mint,
            VaultError::InvalidMint,
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        #[allow(deprecated)]
        token_interface::transfer(cpi_ctx, amount)?;

        emit!(VaultDeposit {
            origin_mint: vault_state.origin_mint,
            depositor: ctx.accounts.depositor.key(),
            amount,
        });
        Ok(())
    })();
    
    // CRITICAL: Always release lock, even if transfer failed
    vault_state.locked = false;
    
    // Propagate error after releasing lock
    result?;
    Ok(())
}
```

## Alternative: Using a Guard Struct

More idiomatic Rust approach:

```rust
struct ReentrancyGuard<'a> {
    vault_state: &'a mut VaultState,
}

impl<'a> ReentrancyGuard<'a> {
    fn new(vault_state: &'a mut VaultState) -> Result<Self> {
        require!(!vault_state.locked, VaultError::ReentrancyDetected);
        vault_state.locked = true;
        Ok(Self { vault_state })
    }
}

impl<'a> Drop for ReentrancyGuard<'a> {
    fn drop(&mut self) {
        self.vault_state.locked = false;
    }
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidDepositAmount);
    
    let vault_state = &mut ctx.accounts.vault_state;
    let _guard = ReentrancyGuard::new(vault_state)?;
    
    // ... rest of function - lock automatically released when guard drops
    // even if function returns early with error
}
```

## Recommended

Use the guard pattern (Option 2) as it's more idiomatic and automatically handles all code paths including early returns.

## References

- Issue location: `programs/vault/src/lib.rs:28-60` (deposit)
- Issue location: `programs/vault/src/lib.rs:63-113` (release)

