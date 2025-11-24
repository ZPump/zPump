# Protocol Fees Withdrawal Without Vault Balance Validation

**Severity:** MEDIUM

**Location:** `programs/pool/src/lib.rs:578-631`

## Description

The `withdraw_protocol_fees` function checks that the withdrawal amount doesn't exceed `protocol_fees`, but doesn't verify that the vault actually has sufficient balance before updating the state. If the CPI to vault fails (e.g., insufficient vault balance), the `protocol_fees` state will have already been decremented, leaving it out of sync with reality.

## Code Reference

```rust
pub fn withdraw_protocol_fees(
    ctx: Context<WithdrawProtocolFees>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, PoolError::InvalidAmount);
    
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    
    // Validate authority
    require_keys_eq!(
        ctx.accounts.authority.key(),
        pool_state.authority,
        PoolError::Unauthorized
    );
    
    // Validate amount doesn't exceed available fees
    let amount_u128 = u128::from(amount);
    require!(
        amount_u128 <= pool_state.protocol_fees,
        PoolError::InsufficientFees
    );
    
    // Update protocol_fees BEFORE CPI
    pool_state.protocol_fees = pool_state
        .protocol_fees
        .checked_sub(amount_u128)
        .ok_or(PoolError::AmountOverflow)?;
    
    // CPI to vault to release tokens
    // If this fails, protocol_fees is already decremented!
    ptf_vault::cpi::release(cpi_ctx, amount)?;
    
    // ...
}
```

## Issue

The state is updated (`protocol_fees` is decremented) before the CPI call. If the vault doesn't have sufficient balance, the CPI will fail, but `protocol_fees` will already be decremented, leaving the state inconsistent.

## Impact

- State inconsistency: `protocol_fees` could be lower than actual available fees
- Potential loss of protocol fees if state becomes corrupted
- Could prevent future withdrawals even if vault balance is restored
- Violates "validate-then-execute" pattern

## Attack Scenario

1. Attacker somehow drains vault balance (unlikely but possible through other vulnerabilities)
2. Authority tries to withdraw protocol fees
3. `protocol_fees` is decremented
4. CPI fails due to insufficient vault balance
5. Transaction fails, but `protocol_fees` remains decremented
6. Future withdrawals are blocked even if vault balance is restored

## Current Mitigations

- Vault's `release` function validates balance before releasing
- Invariant checks (if enabled) should catch this inconsistency
- However, the state update happens before validation

## Recommendation

1. **Validate vault balance before updating state:**
   ```rust
   // Check vault balance BEFORE updating protocol_fees
   let vault_balance = ctx.accounts.vault_token_account.amount;
   require!(
       vault_balance >= amount,
       PoolError::InsufficientVaultBalance
   );
   
   // Now safe to update state
   pool_state.protocol_fees = pool_state
       .protocol_fees
       .checked_sub(amount_u128)
       .ok_or(PoolError::AmountOverflow)?;
   ```

2. **Or use a two-phase commit pattern:**
   - First, validate everything
   - Then, update state and execute CPI atomically
   - If CPI fails, revert state change (requires transaction-level rollback, which Solana doesn't support)

3. **Best approach:** Validate vault balance before updating state, following the "validate-then-execute" pattern already used elsewhere in the codebase.

## Related Patterns

The codebase already uses `validate_then_execute` pattern in vault operations. This function should follow the same pattern.

