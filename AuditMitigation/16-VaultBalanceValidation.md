# Mitigation: No Balance Validation in Release Function

## Severity: HIGH
## Contract: ptf_vault
## Issue ID: 19

## Problem Description

Release function doesn't explicitly validate vault has sufficient balance before releasing tokens.

## Mitigation

Add explicit balance check:

```rust
pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidReleaseAmount);
    
    let vault_state = &ctx.accounts.vault_state;
    validate_pool_authority(&ctx.accounts.pool_authority, &vault_state.pool_authority)?;
    
    // ADD EXPLICIT BALANCE CHECK
    require!(
        ctx.accounts.vault_token_account.amount >= amount,
        VaultError::InsufficientBalance
    );
    
    // ... rest of function
}
```

## References

- Issue location: `programs/vault/src/lib.rs:54-84`

