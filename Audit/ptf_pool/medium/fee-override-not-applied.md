# Fee Override Not Applied in Fee Calculation

**Severity:** MEDIUM

**Location:** `programs/pool/src/lib.rs:2195` (unshield fee calculation)

## Description

The `mint_mapping` account has a `fee_bps_override` field that is intended to allow per-mint fee customization. However, this override is cached in `process_unshield` but never actually used when calculating fees. The `calculate_fee` function always uses `pool_state.fee_bps` instead of checking for the override.

## Code Reference

### Fee Override Cached (line 2030-2031):
```rust
let mint_mapping_has_fee_override = ctx.accounts.mint_mapping.has_fee_override;
let mint_mapping_fee_bps_override = ctx.accounts.mint_mapping.fee_bps_override;
```

### Fee Calculation (line 2195):
```rust
// Calculate expected fee using pool's fee calculation
let expected_fee = pool_state.calculate_fee(args.amount)?;
```

### calculate_fee Function (line 4173-4195):
```rust
pub fn calculate_fee(&self, amount: u64) -> Result<u64> {
    // CRITICAL SECURITY: Use 128-bit intermediate to prevent overflow
    let amount_128 = amount as u128;
    let fee_bps_128 = self.fee_bps as u128;  // Always uses pool_state.fee_bps
    let fee = amount_128
        .checked_mul(fee_bps_128)
        .ok_or(PoolError::AmountOverflow)?
        .checked_div(10_000u128)
        .ok_or(PoolError::AmountOverflow)?;
    // ...
}
```

## Issue

1. **Fee override is cached but never used** - The `mint_mapping_has_fee_override` and `mint_mapping_fee_bps_override` values are read but never passed to or checked by `calculate_fee`.

2. **No validation of override value** - Even if the override were used, there's no validation that `fee_bps_override` is within valid bounds (0-10000).

3. **Inconsistent behavior** - The mint mapping has a fee override feature, but it doesn't actually work, leading to confusion and potential incorrect fee expectations.

## Impact

- **Functional issue**: Fee override feature doesn't work as intended
- **Potential confusion**: Users might expect per-mint fees but get pool-level fees
- **Missing validation**: If implemented, the override value isn't validated

## Attack Scenario

While not directly exploitable, this could lead to:
1. Users expecting different fees based on mint mapping configuration
2. Protocol operators setting fee overrides that have no effect
3. Potential fee manipulation if override is implemented without proper validation

## Current Mitigations

- Pool-level fee (`pool_state.fee_bps`) is validated via `InputValidator::validate_fee_bps`
- Fee calculation has overflow protection
- Minimum fee enforcement prevents fee bypass

## Recommendation

1. **Option A: Implement fee override properly**
   ```rust
   pub fn calculate_fee(&self, amount: u64, fee_override: Option<u16>) -> Result<u64> {
       let fee_bps = fee_override.unwrap_or(self.fee_bps);
       // Validate fee_bps is within bounds
       InputValidator::validate_fee_bps(fee_bps)?;
       // ... rest of calculation
   }
   ```

2. **Option B: Remove fee override feature** if it's not needed
   - Remove `fee_bps_override` and `has_fee_override` from `MintMapping`
   - Remove caching of these values

3. **If implementing Option A:**
   - Validate `fee_bps_override` when mint is registered/updated
   - Use override in `calculate_fee` when `has_fee_override` is true
   - Update fee validation in `process_unshield` to use override if present

## Related Code

- `programs/factory/src/lib.rs` - Where fee override is set during mint registration
- `programs/pool/src/lib.rs:4173` - `calculate_fee` function that should use override
- `programs/pool/src/lib.rs:2195` - Where fee is calculated in unshield

