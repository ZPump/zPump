# Protocol Fees Overflow and Accumulation

## Severity: MEDIUM

## Description

The pool program accumulates protocol fees in a `u128` field. If fees accumulate over a long period without withdrawal, the field could overflow, causing fee loss or incorrect accounting.

## Vulnerability Details

### Current Implementation

Protocol fees are tracked in:
- `protocol_fees: u128` field in `PoolState` (line 2932)
- Fees are added using `checked_add` (lines 1546-1549)
- No withdrawal mechanism visible in the code
- No overflow protection beyond `checked_add`

### Potential Vulnerabilities

1. **u128 Overflow**: If `protocol_fees` reaches `u128::MAX`, adding more fees will overflow, causing incorrect values or panics.

2. **No Withdrawal Mechanism**: There's no visible mechanism to withdraw accumulated fees, leading to unbounded accumulation.

3. **Fee Loss on Overflow**: If overflow occurs, fees could be lost or incorrect values stored.

4. **Accounting Inconsistency**: If fees overflow, the accounting becomes inconsistent, making it difficult to track actual fees.

5. **Long-term Accumulation**: Over years of operation, fees could accumulate to very large values, approaching the limit.

6. **No Monitoring**: There's no monitoring or alerting for approaching overflow limits.

## Exploitation Scenario

```rust
// Scenario 1: u128 overflow
// 1. Protocol operates for many years
// 2. protocol_fees approaches u128::MAX
// 3. Next fee addition overflows
// 4. Fees are lost or incorrect value stored
// 5. Protocol loses revenue

// Scenario 2: No withdrawal
// 1. Fees accumulate indefinitely
// 2. No way to withdraw fees
// 3. Fees are locked in the contract
// 4. Protocol cannot access revenue

// Scenario 3: Accounting error
// 1. Overflow occurs
// 2. protocol_fees wraps around to small value
// 3. Accounting shows incorrect fee total
// 4. Invariant checks might fail incorrectly
```

## Code References

- Protocol fees field: `protocol_fees: u128` in `PoolState` (line 2932)
- Fee accumulation: Lines 1546-1549 in `process_unshield`
- Invariant check: Uses `protocol_fees` in supply invariant (line 1875)

## Mitigation

1. **Withdrawal Mechanism**: Implement a secure withdrawal mechanism for protocol fees with proper authorization.

2. **Overflow Monitoring**: Monitor `protocol_fees` and alert when approaching overflow limits (e.g., 90% of max).

3. **Automatic Withdrawal**: Implement automatic withdrawal when fees reach a threshold to prevent overflow.

4. **Fee Tracking**: Maintain separate tracking of total fees collected vs. current balance to detect overflow.

5. **Overflow Protection**: Add explicit checks before adding fees to prevent overflow.

6. **Periodic Reset**: Consider periodic fee withdrawal to prevent unbounded accumulation.

7. **Event Logging**: Emit events when fees are added and when approaching limits.

## Recommended Code Changes

```rust
// Enhanced protocol fees with overflow protection
pub struct PoolState {
    // ... existing fields ...
    pub protocol_fees: u128,
    pub total_fees_collected: u128, // Track total for overflow detection
}

// Fee addition with overflow protection
fn add_protocol_fee(
    pool_state: &mut PoolState,
    fee: u64,
) -> Result<()> {
    // Check if addition would overflow
    let new_fees = pool_state.protocol_fees
        .checked_add(u128::from(fee))
        .ok_or(PoolError::ProtocolFeesOverflow)?;
    
    // Check if approaching overflow (warn at 90% of max)
    const OVERFLOW_WARNING_THRESHOLD: u128 = u128::MAX / 10 * 9;
    if new_fees > OVERFLOW_WARNING_THRESHOLD {
        msg!("WARNING: Protocol fees approaching overflow limit");
        emit!(ProtocolFeesWarning {
            current_total: pool_state.protocol_fees,
            new_total: new_fees,
        });
    }
    
    pool_state.protocol_fees = new_fees;
    pool_state.total_fees_collected = pool_state.total_fees_collected
        .checked_add(u128::from(fee))
        .ok_or(PoolError::ProtocolFeesOverflow)?;
    
    Ok(())
}

// Withdrawal mechanism
pub fn withdraw_protocol_fees(
    ctx: Context<WithdrawFees>,
    amount: u64,
) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Only authority can withdraw
    require_keys_eq!(
        ctx.accounts.authority.key(),
        pool_state.authority,
        PoolError::Unauthorized
    );
    
    // Validate amount
    require!(
        amount > 0,
        PoolError::InvalidAmount
    );
    
    let amount_128 = u128::from(amount);
    require!(
        pool_state.protocol_fees >= amount_128,
        PoolError::InsufficientFees
    );
    
    // Transfer fees to authority
    // ... transfer logic ...
    
    // Update protocol_fees
    pool_state.protocol_fees = pool_state.protocol_fees
        .checked_sub(amount_128)
        .ok_or(PoolError::ProtocolFeesOverflow)?;
    
    emit!(ProtocolFeesWithdrawn {
        origin_mint: pool_state.origin_mint,
        amount,
        remaining: pool_state.protocol_fees,
        withdrawn_by: ctx.accounts.authority.key(),
    });
    
    Ok(())
}

// Automatic withdrawal trigger
pub fn check_and_withdraw_if_needed(
    ctx: Context<WithdrawFees>,
) -> Result<()> {
    let pool_state = &ctx.accounts.pool_state;
    
    // Withdraw if fees exceed threshold (e.g., 80% of max)
    const AUTO_WITHDRAW_THRESHOLD: u128 = u128::MAX / 10 * 8;
    if pool_state.protocol_fees > AUTO_WITHDRAW_THRESHOLD {
        // Withdraw excess fees
        let excess = pool_state.protocol_fees - AUTO_WITHDRAW_THRESHOLD;
        withdraw_protocol_fees(ctx, excess as u64)?;
    }
    
    Ok(())
}
```

