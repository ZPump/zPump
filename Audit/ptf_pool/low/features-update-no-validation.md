# Features Update Without Input Validation

**Severity:** LOW

**Location:** `programs/pool/src/lib.rs:540-548`

## Description

The `set_features` function allows updating pool features without validating the input `features` byte. This could potentially allow setting invalid feature combinations or reserved bits.

## Code Reference

```rust
pub fn set_features(ctx: Context<UpdateAuthority>, features: u8) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    pool_state.features = FeatureFlags::from(features);
    emit!(FeaturesUpdated {
        origin_mint: pool_state.origin_mint,
        features,
    });
    Ok(())
}
```

## Impact

- Could set invalid feature combinations
- Reserved bits might be set unintentionally
- No validation that features are compatible with each other

## Current Mitigations

- Access control is correct (UpdateAuthority requires authority)
- FeatureFlags::from() handles the conversion
- Features are checked before use in operations

## Recommendation

1. Add validation to ensure only valid feature combinations are allowed
2. Validate that reserved bits are not set
3. Consider adding a whitelist of allowed feature values
4. Add checks for feature compatibility

