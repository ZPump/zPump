# Pause/Unpause Bypass Timelock

**Severity**: HIGH

## Description

The `pause` and `unpause` instructions allow immediate pausing and unpausing of the factory without going through the timelock mechanism. While these operations can also be performed via timelock actions, the direct functions bypass the security delay entirely, allowing an attacker with authority access to immediately halt all factory operations.

## Vulnerability Details

The `pause` and `unpause` functions directly modify the factory state without any timelock delay:

```209:225:programs/factory/src/lib.rs
pub fn pause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    state.paused = true;
    emit!(FactoryPaused {
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}

pub fn unpause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    state.paused = false;
    emit!(FactoryUnpaused {
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}
```

These functions only check that the caller is the factory authority (via the `has_one = authority` constraint), but do not require timelock delays. While `PauseFactory` and `UnpauseFactory` exist as timelock actions, the direct functions provide a bypass.

## Exploitation Scenario

1. **Immediate Pause Attack**: An attacker who compromises the factory authority can immediately pause the factory, preventing:
   - New mint registrations
   - Timelock action queuing
   - All operations that check `require!(!state.paused, FactoryError::Paused)`

2. **Denial of Service**: An attacker could pause the factory right before critical operations, causing them to fail and potentially causing financial loss.

3. **Rapid Pause/Unpause Cycles**: An attacker could rapidly pause and unpause the factory to disrupt operations and create confusion.

4. **Bypass Timelock Protection**: Unlike other critical operations, pause/unpause can be executed immediately, bypassing the timelock mechanism entirely.

## Code References

```209:225:programs/factory/src/lib.rs
pub fn pause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    state.paused = true;
    // ... no timelock check ...
}

pub fn unpause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    state.paused = false;
    // ... no timelock check ...
}
```

```479:490:programs/factory/src/lib.rs
TimelockAction::PauseFactory => {
    state.paused = true;
    emit!(FactoryPaused {
        authority: state.authority,
    });
}
TimelockAction::UnpauseFactory => {
    state.paused = false;
    emit!(FactoryUnpaused {
        authority: state.authority,
    });
}
```

The timelock actions exist, but the direct functions provide a bypass.

## Mitigation

1. **Require Timelock for Pause/Unpause**: Make the direct `pause` and `unpause` functions call `ensure_direct_update_allowed`, which will reject direct calls and force all pause/unpause operations through the timelock.

2. **Remove Direct Pause/Unpause Functions**: Alternatively, deprecate or remove the direct functions entirely, requiring all pause/unpause operations to go through timelock.

3. **Emergency Pause Exception**: Consider allowing emergency pause without timelock (for security incidents), but require a longer timelock for unpausing.

## Recommended Code Changes

Modify existing functions to require timelock:

```rust
pub fn pause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
    let state = &ctx.accounts.factory_state;
    ensure_direct_update_allowed(state)?; // This will reject direct calls
    // ... rest of function ...
}

pub fn unpause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
    let state = &ctx.accounts.factory_state;
    ensure_direct_update_allowed(state)?; // This will reject direct calls
    // ... rest of function ...
}
```

Or remove the direct functions entirely and require all pause/unpause operations to go through `queue_timelock_action` with `TimelockAction::PauseFactory` or `TimelockAction::UnpauseFactory`.

## Additional Considerations

- Consider implementing an emergency pause mechanism that can be triggered by multiple parties (e.g., multi-sig) without timelock, but require timelock for unpause.
- Add monitoring and alerting for pause/unpause operations.
- Consider requiring a longer timelock for unpause than for pause to give users time to react.

