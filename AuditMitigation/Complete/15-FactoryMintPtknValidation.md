# Mitigation: Mint PTKN Function Lacks Validation

## Severity: HIGH
## Contract: ptf_factory
## Issue ID: 18

## Problem Description

Mint PTKN function doesn't validate pool state, amount limits, or destination account thoroughly.

## Mitigation

Add comprehensive validation:

```rust
pub const MAX_MINT_AMOUNT: u64 = 1_000_000_000_000; // Reasonable limit

pub fn mint_ptkn(ctx: Context<MintPtkn>, amount: u64) -> Result<()> {
    require!(amount > 0, FactoryError::InvalidAmount);
    require!(amount <= MAX_MINT_AMOUNT, FactoryError::AmountTooLarge);
    
    // Validate pool is initialized and active
    let pool_state = ctx.accounts.pool_state.load()?;
    require!(
        pool_state.origin_mint != Pubkey::default(),
        FactoryError::PoolNotInitialized
    );
    
    // Validate destination account
    require!(
        ctx.accounts.destination_token_account.owner != Pubkey::default(),
        FactoryError::InvalidDestination
    );
    
    // ... rest of function
}
```

## References

- Issue location: `programs/factory/src/lib.rs:489-549`

