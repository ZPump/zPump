# Supply Invariant Edge Cases and Failures

## Severity: HIGH

## Description

The supply invariant check ensures that vault balance equals the sum of twin mint supply, live value, and protocol fees. If this invariant fails incorrectly or has edge cases, it could block legitimate operations or allow invalid states.

## Vulnerability Details

### Current Implementation

Supply invariant calculation (lines 1865-1880):
- `expected = twin_supply + live_value + protocol_fees`
- `require!(vault_balance == expected, PoolError::InvariantBreach)`
- Uses `checked_add` for overflow protection

### Potential Vulnerabilities

1. **Exact Equality Requirement**: The invariant requires exact equality. If there's any rounding or calculation error, legitimate operations could be blocked.

2. **Twin Mint Supply Race**: Twin mint supply could change between when it's read and when the invariant is checked.

3. **Protocol Fees Accumulation**: If protocol fees accumulate between operations, the invariant could fail.

4. **Vault Balance Race**: Vault balance could change between reads if multiple transactions execute simultaneously.

5. **Overflow in Calculation**: While `checked_add` is used, if all three components are large, the sum could overflow.

6. **Twin Mint Enabled Mismatch**: If `twin_mint_enabled` doesn't match the actual twin mint state, calculations could be wrong.

7. **Sampling Bypass**: Since invariant checks are sampled, many operations might proceed without checks, allowing inconsistencies to accumulate.

8. **Timing Issues**: Invariant is checked after operations complete, but state might have changed.

## Exploitation Scenario

```rust
// Scenario 1: Exact equality failure
// 1. Protocol fees accumulate to odd value
// 2. Live value calculation has rounding
// 3. Expected value doesn't exactly match vault balance
// 4. Invariant check fails, blocking legitimate operations

// Scenario 2: Race condition
// 1. Transaction A reads twin mint supply: 1000
// 2. Transaction B mints twin tokens: supply becomes 1100
// 3. Transaction A checks invariant with old supply (1000)
// 4. Invariant fails incorrectly

// Scenario 3: Overflow
// 1. Twin supply, live value, and protocol fees are all very large
// 2. Sum calculation overflows
// 3. Invariant check fails or produces incorrect result
// 4. Operations are blocked or incorrect state is allowed

// Scenario 4: Sampling bypass
// 1. Many operations avoid invariant checks due to sampling
// 2. Small inconsistencies accumulate
// 3. Eventually invariant is violated but not detected
// 4. System enters invalid state
```

## Code References

- Invariant enforcement: `enforce_supply_invariant` (lines 1841-1863)
- Supply validation: `validate_supply_components` (lines 1865-1880)
- Invariant sampling: `should_enforce_invariant` (lines 3388-3398)
- Invariant check call: Line 976 in `shield_check_invariant`, line 1713 in `process_unshield`

## Mitigation

1. **Tolerance for Rounding**: Allow small tolerance (e.g., 1 lamport) for rounding errors instead of exact equality.

2. **Atomic State Reading**: Read all state values atomically to prevent race conditions.

3. **Overflow Protection**: Ensure sum calculation cannot overflow, use saturating arithmetic if needed.

4. **More Frequent Checks**: Reduce sampling interval or make checks mandatory for larger operations.

5. **State Snapshot**: Take a snapshot of all relevant state at the start of the check to ensure consistency.

6. **Twin Mint Validation**: Strictly validate twin mint state matches `twin_mint_enabled` flag.

7. **Invariant Monitoring**: Monitor invariant failures and alert on patterns that might indicate issues.

8. **Recovery Mechanism**: Implement mechanism to recover from invariant breaches.

## Recommended Code Changes

```rust
// Enhanced supply invariant with tolerance
fn validate_supply_components(
    pool_state: &PoolState,
    note_ledger: &NoteLedger,
    twin_supply: u128,
    vault_balance: u128,
) -> Result<u128> {
    // Calculate expected with overflow protection
    let expected = twin_supply
        .saturating_add(note_ledger.live_value)
        .saturating_add(pool_state.protocol_fees);
    
    // Check for overflow
    if expected < twin_supply || expected < note_ledger.live_value {
        return err!(PoolError::AmountOverflow);
    }
    
    // Allow small tolerance for rounding (1 lamport)
    const TOLERANCE: u128 = 1;
    let diff = if vault_balance > expected {
        vault_balance - expected
    } else {
        expected - vault_balance
    };
    
    require!(
        diff <= TOLERANCE,
        PoolError::InvariantBreach
    );
    
    // Log if there's any difference (even within tolerance)
    if diff > 0 {
        msg!("WARNING: Supply invariant has small difference: {}", diff);
    }
    
    Ok(expected)
}

// Atomic state reading
fn enforce_supply_invariant_atomic<'info>(
    pool_state: &PoolState,
    note_ledger: &NoteLedger,
    vault_token_account: &InterfaceAccount<'info, TokenAccount>,
    twin_mint: Option<&InterfaceAccount<'info, Mint>>,
) -> Result<()> {
    // Read all values in quick succession to minimize race conditions
    let vault_balance = u128::from(vault_token_account.amount);
    let live_value = note_ledger.live_value;
    let protocol_fees = pool_state.protocol_fees;
    
    let twin_supply = match (pool_state.twin_mint_enabled, twin_mint) {
        (true, Some(mint)) => {
            require_keys_eq!(
                mint.key(),
                pool_state.twin_mint,
                PoolError::TwinMintMismatch
            );
            u128::from(mint.supply) // Read supply atomically
        }
        (true, None) => return err!(PoolError::TwinMintNotConfigured),
        (false, Some(_)) => return err!(PoolError::TwinMintMismatch),
        (false, None) => 0u128,
    };
    
    validate_supply_components(pool_state, note_ledger, twin_supply, vault_balance)
}
```

