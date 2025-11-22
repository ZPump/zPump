# Live Value Accounting and Consistency

## Severity: HIGH

## Description

The `NoteLedger` tracks `live_value` which represents the total value of unspent notes. If this accounting is incorrect, the supply invariant could fail or allow invalid operations.

## Vulnerability Details

### Current Implementation

Live value tracking:
- `record_shield`: Adds to `live_value` (lines 3306-3313)
- `record_unshield`: Subtracts from `live_value` (lines 3357-3360)
- `record_transfer`: Doesn't change `live_value` (only updates counts)
- `ensure_capacity`: Checks `live_value >= amount` (lines 3380-3386)

### Potential Vulnerabilities

1. **Live Value Overflow**: If `live_value` overflows, it could wrap around to a small value, allowing invalid operations.

2. **Live Value Underflow**: If `live_value` underflows, it could become very large, blocking legitimate operations.

3. **Accounting Mismatch**: If `live_value` doesn't match actual unspent notes, the invariant could fail or allow invalid states.

4. **Transfer Accounting**: Transfers don't update `live_value`, which is correct, but if there's an error in the logic, accounting could be wrong.

5. **Concurrent Updates**: If multiple transactions update `live_value` simultaneously, accounting could become inconsistent.

6. **Initialization Issues**: If `live_value` is initialized incorrectly, all subsequent accounting is wrong.

7. **Rounding Errors**: If there are rounding errors in calculations, `live_value` could drift from actual value.

## Exploitation Scenario

```rust
// Scenario 1: Live value overflow
// 1. Many large shields occur
// 2. live_value approaches u128::MAX
// 3. Next shield causes overflow
// 4. live_value wraps to small value
// 5. Invalid operations are allowed

// Scenario 2: Accounting mismatch
// 1. Bug in record_shield or record_unshield
// 2. live_value doesn't match actual unspent notes
// 3. Invariant checks fail or pass incorrectly
// 4. Invalid state is allowed

// Scenario 3: Concurrent updates
// 1. Transaction A reads live_value: 1000
// 2. Transaction B reads live_value: 1000
// 3. Transaction A adds 100: live_value = 1100
// 4. Transaction B subtracts 50: live_value = 950
// 5. Final value is 950, but should be 1050
// 6. Accounting is incorrect
```

## Code References

- Live value updates: `record_shield` (lines 3306-3313), `record_unshield` (lines 3357-3360)
- Live value check: `ensure_capacity` (lines 3380-3386)
- Live value in invariant: Line 1873

## Mitigation

1. **Overflow Protection**: Use saturating arithmetic or explicit overflow checks for `live_value` updates.

2. **Underflow Protection**: Ensure `live_value` cannot underflow below zero.

3. **Accounting Validation**: Periodically validate that `live_value` matches sum of unspent notes.

4. **Atomic Updates**: Ensure `live_value` updates are atomic and cannot be partially applied.

5. **Bounds Checking**: Add bounds checking to ensure `live_value` stays within reasonable limits.

6. **Recovery Mechanism**: Implement mechanism to recalculate `live_value` from actual state if it becomes inconsistent.

7. **Event Logging**: Log all `live_value` changes for audit and debugging.

8. **Consistency Checks**: Add consistency checks that validate `live_value` against other state.

## Recommended Code Changes

```rust
// Enhanced live value tracking with overflow protection
impl NoteLedger {
    pub fn record_shield(&mut self, amount: u64, amount_commit: [u8; 32]) -> Result<()> {
        // Check for overflow before updating
        let new_live_value = self.live_value
            .checked_add(u128::from(amount))
            .ok_or(PoolError::LiveValueOverflow)?;
        
        // Check bounds (reasonable maximum)
        const MAX_LIVE_VALUE: u128 = 1_000_000_000_000_000_000; // 1 quintillion
        require!(
            new_live_value <= MAX_LIVE_VALUE,
            PoolError::LiveValueTooLarge
        );
        
        self.total_minted = self
            .total_minted
            .checked_add(u128::from(amount))
            .ok_or(PoolError::AmountOverflow)?;
        self.live_value = new_live_value;
        self.notes_created = self
            .notes_created
            .checked_add(1)
            .ok_or(PoolError::AmountOverflow)?;
        
        #[cfg(feature = "note_digests")]
        self.absorb_amount_commitments(core::slice::from_ref(&amount_commit));
        
        Ok(())
    }
    
    pub fn record_unshield(
        &mut self,
        total_spent: u64,
        nullifiers: &[[u8; 32]],
        output_amount_commitments: &[[u8; 32]],
    ) -> Result<()> {
        let total_spent_128 = u128::from(total_spent);
        
        // Check for underflow
        require!(
            self.live_value >= total_spent_128,
            PoolError::InsufficientLiquidity
        );
        
        self.total_spent = self
            .total_spent
            .checked_add(total_spent_128)
            .ok_or(PoolError::AmountOverflow)?;
        self.live_value = self
            .live_value
            .checked_sub(total_spent_128)
            .ok_or(PoolError::InsufficientLiquidity)?;
        
        // ... rest of method ...
        Ok(())
    }
    
    // Validation method
    pub fn validate_live_value(&self) -> Result<()> {
        // Basic sanity checks
        require!(
            self.live_value <= self.total_minted,
            PoolError::LiveValueExceedsTotal
        );
        
        require!(
            self.live_value >= self.total_spent.saturating_sub(self.total_minted),
            PoolError::LiveValueInconsistent
        );
        
        Ok(())
    }
}
```

