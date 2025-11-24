# Protocol Fees Withdrawal Without Vault Balance Validation

**Severity:** MEDIUM  
**Status:** ✅ MITIGATED

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

1. ✅ **Validate vault balance before updating state** - **FIXED**
   - Vault balance is now validated before updating `protocol_fees` state
   - Uses `PoolError::InsufficientLiquidity` error (existing error type)
   - Follows "validate-then-execute" pattern

## Mitigation Status

**Fixed in:** Commit d1cf0fd

**Changes Made:**
- Added vault balance validation before state update (line ~599-603)
- State update now happens after validation, preventing inconsistency
- If vault balance is insufficient, transaction fails before state is modified

## Related Patterns

The codebase already uses `validate_then_execute` pattern in vault operations. This function should follow the same pattern.

