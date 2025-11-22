# Integer Overflow and Underflow

## Severity: MEDIUM

## Description

While Rust's checked arithmetic provides some protection against overflow/underflow, there are still potential vulnerabilities in arithmetic operations, especially when dealing with token amounts, fees, and calculations.

## Vulnerability Details

### Current Implementation

The code uses `checked_add`, `checked_sub`, and similar checked arithmetic operations in many places, but there are still areas of concern:

1. **Fee Calculations**: Fee calculations use basis points (BPS). If fee_bps is set incorrectly or calculations are wrong, overflow could occur.

2. **Amount Commitments**: Amount commitments are field elements that could overflow if amounts are too large.

3. **Supply Invariant Checks**: When checking supply invariants, large numbers could cause overflow in calculations.

4. **Nullifier Set Growth**: The nullifier set account size calculations could overflow if too many nullifiers are added.

5. **Root History**: The recent_roots array has a fixed size, but calculations for managing it could overflow.

## Exploitation Scenario

```rust
// Scenario 1: Fee calculation overflow
// 1. If fee_bps is set to a very large value (close to MAX_BPS)
// 2. Fee calculation: amount * fee_bps / 10000
// 3. If amount is also large, multiplication could overflow
// 4. Result could be incorrect, allowing free transactions or excessive fees

// Scenario 2: Amount commitment overflow
// 1. Attacker attempts to shield an extremely large amount
// 2. Amount commitment calculation overflows
// 3. Commitment might be incorrect, allowing manipulation

// Scenario 3: Supply invariant overflow
// 1. Pool has accumulated very large amounts
// 2. Invariant check: total_supply calculation overflows
// 3. Check might pass incorrectly, allowing inconsistent state
```

## Code References

- Fee calculations: Throughout the codebase, especially in shield/unshield operations
- Amount commitments: Used in shield, unshield, and transfer operations
- Supply invariant: `enforce_supply_invariant` function
- Nullifier set: Account size calculations

## Mitigation

1. **Comprehensive Checked Arithmetic**: Ensure all arithmetic operations use checked variants (`checked_add`, `checked_mul`, etc.) and handle overflow errors appropriately.

2. **Amount Limits**: Implement maximum amounts for shield, unshield, and transfer operations to prevent overflow scenarios.

3. **Fee Validation**: Strictly validate fee_bps values and ensure fee calculations cannot overflow. Consider using a more robust fee calculation method.

4. **Supply Invariant Safeguards**: Add overflow checks in supply invariant calculations and use saturating arithmetic where appropriate.

5. **Account Size Limits**: Implement maximum sizes for accounts (nullifier set, note ledger, etc.) to prevent overflow in size calculations.

6. **Testing**: Add comprehensive tests with edge cases including maximum values, zero values, and values near overflow thresholds.

## Recommended Code Changes

```rust
// Add amount limits
pub const MAX_SHIELD_AMOUNT: u64 = 1_000_000_000_000_000; // 1 quadrillion
pub const MAX_UNSHIELD_AMOUNT: u64 = 1_000_000_000_000_000;

// In shield
require!(
    args.amount <= MAX_SHIELD_AMOUNT,
    PoolError::AmountTooLarge
);

// Safe fee calculation
fn calculate_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    // Use 128-bit intermediate to prevent overflow
    let amount_128 = amount as u128;
    let fee_bps_128 = fee_bps as u128;
    let fee = (amount_128 * fee_bps_128) / 10_000;
    
    // Ensure result fits in u64
    require!(
        fee <= u64::MAX as u128,
        PoolError::FeeCalculationOverflow
    );
    
    Ok(fee as u64)
}

// Safe supply calculation
fn calculate_total_supply(
    note_ledger: &NoteLedger,
) -> Result<u128> {
    let mut total: u128 = 0;
    for entry in &note_ledger.recent_commitments {
        total = total
            .checked_add(entry.amount_commit as u128)
            .ok_or(PoolError::SupplyCalculationOverflow)?;
    }
    Ok(total)
}
```

