# Mitigation: Missing Reentrancy Protection in Deposit

## Severity: HIGH
## Contract: ptf_vault
## Issue ID: 20

## Problem Description

Deposit function performs CPI without reentrancy guards, potentially vulnerable in hook contexts.

## Mitigation

Add reentrancy guard:

```rust
#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub bump: u8,
    pub locked: bool, // ADD REENTRANCY GUARD
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let vault_state = &mut ctx.accounts.vault_state;
    
    // REENTRANCY GUARD
    require!(!vault_state.locked, VaultError::ReentrancyDetected);
    vault_state.locked = true;
    
    // ... perform deposit ...
    
    vault_state.locked = false;
    Ok(())
}
```

## Alternative

Use Anchor's built-in reentrancy protection or ensure deposit is never called from hooks.

## References

- Issue location: `programs/vault/src/lib.rs:27-52`

