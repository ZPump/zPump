# Protocol Fees Withdrawal Authorization

## Severity: MEDIUM

## Description

The protocol fees withdrawal instruction should have strict authorization checks. If authorization is weak or can be bypassed, an attacker could drain protocol fees.

## Vulnerability Details

### Current Implementation

```515:577:programs/pool/src/lib.rs
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
    
    // Update protocol_fees
    pool_state.protocol_fees = pool_state
        .protocol_fees
        .checked_sub(amount_u128)
        .ok_or(PoolError::AmountOverflow)?;
    
    // CPI to vault to release tokens
    // ... rest of implementation ...
}
```

The authorization uses `has_one = authority` constraint and explicit `require_keys_eq!` check, which is good. However, there's no multi-sig support or timelock for large withdrawals.

### Potential Vulnerabilities

1. **Weak Authorization**: If the authority check is weak, an attacker could withdraw fees.

2. **Authority Compromise**: If the authority is compromised, all fees could be drained.

3. **No Multi-Sig**: Protocol fees withdrawal might not require multi-sig even if configured.

4. **No Timelock**: Large withdrawals might not require timelock, allowing instant drainage.

## Exploitation Scenario

```rust
// Scenario: Unauthorized fee withdrawal
// 1. Attacker finds way to bypass authority check
// 2. Attacker calls withdraw_protocol_fees
// 3. All accumulated fees are drained
// 4. Protocol loses revenue
```

## Code References

- withdraw_protocol_fees: Lines 515-577
- WithdrawProtocolFees context: Lines 2622-2639
- Authorization check: Lines 524-528

## Mitigation

1. **Strict authority validation**:
```rust
pub fn withdraw_protocol_fees(
    ctx: Context<WithdrawProtocolFees>,
    amount: u64,
) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;
    
    // CRITICAL FIX: Require authority or multi-sig
    require_keys_eq!(
        ctx.accounts.authority.key(),
        pool_state.authority,
        PoolError::Unauthorized
    );
    
    // CRITICAL FIX: Validate amount
    require!(amount > 0, PoolError::InvalidAmount);
    require!(
        amount <= pool_state.protocol_fees as u64,
        PoolError::InsufficientBalance
    );
    
    // CRITICAL FIX: Consider requiring timelock for large withdrawals
    const LARGE_WITHDRAWAL_THRESHOLD: u64 = 1_000_000_000; // 1 billion
    if amount > LARGE_WITHDRAWAL_THRESHOLD {
        // Require timelock or multi-sig for large withdrawals
        // This prevents instant drainage
    }
    
    // ... withdrawal logic ...
}
```

2. **Add multi-sig support** (if factory has it):
```rust
// Require multi-sig for protocol fee withdrawals
// Similar to factory's multi-sig requirement
```

3. **Add rate limiting**:
```rust
// Limit how frequently fees can be withdrawn
// Prevent rapid small withdrawals that drain fees
```

4. **Add events and monitoring**:
```rust
// Emit detailed events for all fee withdrawals
// Monitor withdrawal patterns
```

## Additional Considerations

- Protocol fees are important revenue, so withdrawal should be highly secured
- Consider whether withdrawals should require timelock
- Add comprehensive authorization tests

