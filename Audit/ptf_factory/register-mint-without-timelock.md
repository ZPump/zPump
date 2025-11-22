# Register Mint Without Timelock

**Severity**: MEDIUM

## Description

The `register_mint` instruction allows immediate registration of new mints without going through the timelock mechanism. This allows the factory authority to quickly register new mints, potentially including malicious or improperly configured mints, without the security delay that protects other critical operations.

## Vulnerability Details

The `register_mint` function directly creates or updates mint mappings without any timelock delay:

```80:152:programs/factory/src/lib.rs
pub fn register_mint(
    ctx: Context<RegisterMint>,
    decimals: u8,
    enable_ptkn: bool,
    feature_flags: Option<u8>,
    fee_bps_override: Option<u16>,
) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    require!(!state.paused, FactoryError::Paused);
    // ... validation ...
    // Directly modifies mint_mapping without timelock
    // ...
}
```

This function only checks that the factory is not paused and that the caller is the factory authority, but does not require timelock delays.

## Exploitation Scenario

1. **Rapid Mint Registration**: An attacker who compromises the factory authority can quickly register multiple malicious mints before users can react.

2. **Malicious Mint Configuration**: An attacker could register mints with:
   - Excessive fee overrides
   - Dangerous feature flags
   - Improperly configured PTKN mints
   - Mints that could be used for attacks

3. **Bypass Timelock Protection**: Unlike mint updates (which require timelock), new mint registrations bypass the security delay entirely.

4. **Race Condition**: An attacker could register a mint and immediately use it before users can review or object.

## Code References

```80:152:programs/factory/src/lib.rs
pub fn register_mint(
    ctx: Context<RegisterMint>,
    decimals: u8,
    enable_ptkn: bool,
    feature_flags: Option<u8>,
    fee_bps_override: Option<u16>,
) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    require!(!state.paused, FactoryError::Paused);
    // ... no timelock check ...
    // Directly modifies mint_mapping
}
```

Note that `update_mint` requires timelock (via `ensure_direct_update_allowed`), but `register_mint` does not.

## Mitigation

1. **Require Timelock for Mint Registration**: Add a `RegisterMint` action to the `TimelockAction` enum and require all mint registrations to go through the timelock mechanism.

2. **Add Rate Limiting**: Even if timelock is added, consider adding rate limiting to prevent rapid mint registration.

3. **Enhanced Validation**: Add additional validation checks for mint registration, including:
   - Verification of mint metadata
   - Checks for known malicious mints
   - Validation of fee overrides and feature flags

## Recommended Code Changes

Add to `TimelockAction` enum:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    // ... existing actions ...
    RegisterMint {
        origin_mint: Pubkey,
        decimals: u8,
        enable_ptkn: bool,
        feature_flags: Option<u8>,
        fee_bps_override: Option<u16>,
    },
}
```

Add execution logic in `execute_timelock_action`:

```rust
match &entry.action {
    // ... existing actions ...
    TimelockAction::RegisterMint {
        origin_mint,
        decimals,
        enable_ptkn,
        feature_flags,
        fee_bps_override,
    } => {
        // Perform the registration logic here
        // This would require passing additional accounts to ExecuteTimelockAction
    }
}
```

Modify existing function to require timelock:

```rust
pub fn register_mint(ctx: Context<RegisterMint>, ...) -> Result<()> {
    let state = &ctx.accounts.factory_state;
    // Option 1: Require timelock for all registrations
    ensure_direct_update_allowed(state)?;
    
    // Option 2: Allow direct registration but with additional validation
    // Add stricter validation checks here
}
```

## Additional Considerations

- Consider allowing direct registration for trusted mints (e.g., whitelist), but require timelock for others.
- Add monitoring and alerting for mint registrations.
- Consider requiring multiple signatures for mint registrations on critical tokens.
- Implement a review period before newly registered mints can be used in pools.

