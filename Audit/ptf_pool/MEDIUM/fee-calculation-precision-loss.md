# Fee Calculation Precision Loss

## Severity: MEDIUM

## Description

The fee calculation uses integer division (`checked_div(10_000u128)`), which can cause precision loss for small amounts. For very small amounts, the fee might round down to 0, allowing free transactions.

## Vulnerability Details

### Current Implementation

```3709:3727:programs/pool/src/lib.rs
pub fn calculate_fee(&self, amount: u64) -> Result<u64> {
    // CRITICAL SECURITY: Use 128-bit intermediate to prevent overflow
    // amount * fee_bps can be up to u64::MAX * 10000, which fits in u128
    let amount_128 = amount as u128;
    let fee_bps_128 = self.fee_bps as u128;
    let fee = amount_128
        .checked_mul(fee_bps_128)
        .ok_or(PoolError::AmountOverflow)?
        .checked_div(10_000u128)
        .ok_or(PoolError::AmountOverflow)?;
    
    // Ensure result fits in u64
    require!(
        fee <= u64::MAX as u128,
        PoolError::AmountOverflow
    );
    
    Ok(fee as u64)
}
```

### Potential Vulnerabilities

1. **Precision Loss**: For small amounts, integer division rounds down:
   - amount = 1, fee_bps = 1 (0.01%): fee = (1 * 1) / 10000 = 0
   - amount = 99, fee_bps = 1: fee = (99 * 1) / 10000 = 0
   - Free transactions for small amounts

2. **Fee Bypass**: Attackers could split large transactions into many small transactions to avoid fees.

3. **Minimum Fee Not Enforced**: There's no minimum fee, so very small transactions are free.

## Exploitation Scenario

```rust
// Scenario: Fee bypass via small transactions
// 1. Attacker wants to transfer 1,000,000 tokens
// 2. Instead of 1 transaction with fee, splits into 10,000 transactions of 100 tokens each
// 3. Each transaction: fee = (100 * fee_bps) / 10000
// 4. If fee_bps is small, fee rounds to 0
// 5. Attacker avoids all fees
```

## Code References

- `calculate_fee`: Lines 3709-3727
- Fee calculation in unshield: Uses `calculate_fee`

## Mitigation

1. **Add minimum fee**:
```rust
pub fn calculate_fee(&self, amount: u64) -> Result<u64> {
    let amount_128 = amount as u128;
    let fee_bps_128 = self.fee_bps as u128;
    let fee = amount_128
        .checked_mul(fee_bps_128)
        .ok_or(PoolError::AmountOverflow)?
        .checked_div(10_000u128)
        .ok_or(PoolError::AmountOverflow)?;
    
    // CRITICAL FIX: Enforce minimum fee to prevent fee bypass
    const MIN_FEE: u64 = 1; // 1 lamport minimum fee
    let fee_u64 = fee as u64;
    Ok(fee_u64.max(MIN_FEE))
}
```

2. **Use rounding up**:
```rust
// Round up instead of down to prevent free transactions
let fee = (amount_128 * fee_bps_128 + 9_999) / 10_000; // Round up
```

3. **Add minimum transaction amount**:
```rust
// Require minimum transaction amount to make fees meaningful
const MIN_TRANSACTION_AMOUNT: u64 = 1000; // Minimum 1000 units
require!(
    amount >= MIN_TRANSACTION_AMOUNT,
    PoolError::AmountTooSmall
);
```

4. **Document fee behavior**:
```rust
// Document that fees round down and small transactions might be free
// Consider whether this is acceptable or should be changed
```

## Additional Considerations

- Precision loss is inherent in integer division
- Consider whether free small transactions are acceptable
- Minimum fee prevents fee bypass but might affect small users
- Consider using fixed-point arithmetic for better precision

