# Fee Override Validation Inconsistency

**Severity:** LOW

**Location:** `programs/factory/src/lib.rs:128-134` (register_mint) vs `1375-1378` (apply_mint_update)

## Description

The `fee_bps_override` validation is inconsistent between `register_mint` and `apply_mint_update` (used by `update_mint`). `register_mint` validates that the override is <= 1000 bps (10%), but `apply_mint_update` only validates <= MAX_BPS (10000 bps / 100%).

## Code Reference

### register_mint (line 128-134):
```rust
// CRITICAL FIX: Validate fee override limits to prevent abuse
// Allow 0 to 1000 bps (0% to 10%) for reasonable fee ranges
const MAX_FEE_BPS_OVERRIDE: u16 = 1000; // 10% maximum override
if let Some(fee) = fee_bps_override {
    require!(fee <= MAX_BPS, FactoryError::InvalidFeeBps);
    require!(fee <= MAX_FEE_BPS_OVERRIDE, FactoryError::InvalidFeeBps);
}
```

### apply_mint_update (line 1375-1378):
```rust
if let Some(fee) = params.fee_bps_override {
    require!(fee <= MAX_BPS, FactoryError::InvalidFeeBps);
    mapping.fee_bps_override = fee;
    mapping.has_fee_override = true;
}
```

## Issue

1. **Inconsistent validation** - `register_mint` enforces a 10% maximum (1000 bps), but `update_mint` allows up to 100% (10000 bps)
2. **Potential bypass** - An attacker could register a mint with a low fee override, then update it to a much higher fee override
3. **Policy inconsistency** - The 10% limit in `register_mint` suggests a policy decision, but it's not enforced in updates

## Impact

- **Low impact** since:
  - Both require authority (timelock for updates)
  - Fee override is not actually used in fee calculation (see `fee-override-not-applied.md`)
  - Even if used, authority controls would prevent abuse
- **Policy inconsistency** - Suggests unclear requirements

## Attack Scenario

1. Attacker (with authority) registers mint with 5% fee override (500 bps)
2. Later, attacker updates mint to 50% fee override (5000 bps) via timelock
3. If fee override were implemented, this would allow higher fees than intended

## Current Mitigations

- Authority required for both operations
- Timelock required for updates (prevents immediate changes)
- Fee override is not actually used (see `fee-override-not-applied.md`)

## Recommendation

1. **Make validation consistent** - Apply the same 10% limit in `apply_mint_update`:
   ```rust
   const MAX_FEE_BPS_OVERRIDE: u16 = 1000; // 10% maximum override
   if let Some(fee) = params.fee_bps_override {
       require!(fee <= MAX_BPS, FactoryError::InvalidFeeBps);
       require!(fee <= MAX_FEE_BPS_OVERRIDE, FactoryError::InvalidFeeBps);
       mapping.fee_bps_override = fee;
       mapping.has_fee_override = true;
   }
   ```

2. **Or remove the 10% limit** if it's not a policy requirement:
   - Remove `MAX_FEE_BPS_OVERRIDE` check from `register_mint`
   - Keep only `MAX_BPS` validation in both places

3. **Document the policy** - If 10% is intentional, document why and enforce consistently

## Related Issues

- See `Audit/ptf_pool/medium/fee-override-not-applied.md` - Fee override is not used in fee calculation

## Related Code

- `programs/factory/src/lib.rs:118` - `register_mint` function
- `programs/factory/src/lib.rs:202` - `update_mint` function
- `programs/factory/src/lib.rs:1365` - `apply_mint_update` function

