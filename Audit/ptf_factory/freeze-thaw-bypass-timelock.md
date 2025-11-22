# Freeze/Thaw Bypass Timelock

**Severity**: HIGH

## Description

The `freeze_mapping` and `thaw_mapping` instructions allow immediate freezing and thawing of mint mappings without going through the timelock mechanism. This bypasses the security delay that protects other critical operations, allowing an attacker with authority access to quickly freeze mints and disrupt operations.

## Vulnerability Details

The `freeze_mapping` and `thaw_mapping` functions directly modify the mint status without any timelock delay:

```189:207:programs/factory/src/lib.rs
pub fn freeze_mapping(ctx: Context<MutationMintState>) -> Result<()> {
    let mapping = &mut ctx.accounts.mint_mapping;
    mapping.status = MintStatus::Frozen as u8;
    emit!(MintFrozen {
        origin_mint: mapping.origin_mint,
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}

pub fn thaw_mapping(ctx: Context<MutationMintState>) -> Result<()> {
    let mapping = &mut ctx.accounts.mint_mapping;
    mapping.status = MintStatus::Active as u8;
    emit!(MintThawed {
        origin_mint: mapping.origin_mint,
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}
```

These functions only check that the caller is the factory authority (via the `has_one = authority` constraint), but do not require timelock delays.

## Exploitation Scenario

1. **Immediate Freeze Attack**: An attacker who compromises the factory authority can immediately freeze all mints, preventing users from:
   - Shielding tokens
   - Unshielding tokens
   - Minting PTKN tokens
   - Performing private transfers

2. **Freeze During Critical Operations**: An attacker could freeze a mint right before a large unshield operation, causing it to fail and potentially causing financial loss.

3. **Rapid Freeze/Thaw Cycles**: An attacker could rapidly freeze and thaw mints to disrupt operations and create confusion.

4. **Bypass Timelock Protection**: Unlike other critical operations (pause, update mint, etc.), freeze/thaw bypass the timelock mechanism entirely, allowing immediate execution.

## Code References

```189:207:programs/factory/src/lib.rs
pub fn freeze_mapping(ctx: Context<MutationMintState>) -> Result<()> {
    let mapping = &mut ctx.accounts.mint_mapping;
    mapping.status = MintStatus::Frozen as u8;
    // ... no timelock check ...
}

pub fn thaw_mapping(ctx: Context<MutationMintState>) -> Result<()> {
    let mapping = &mut ctx.accounts.mint_mapping;
    mapping.status = MintStatus::Active as u8;
    // ... no timelock check ...
}
```

```705:712:programs/factory/src/lib.rs
#[derive(Accounts)]
pub struct MutationMintState<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::MINT_MAPPING, mint_mapping.origin_mint.as_ref()], bump = mint_mapping.bump)]
    pub mint_mapping: Account<'info, MintMapping>,
}
```

## Mitigation

1. **Require Timelock for Freeze/Thaw**: Add `FreezeMint` and `ThawMint` actions to the `TimelockAction` enum and require these operations to go through the timelock mechanism.

2. **Remove Direct Freeze/Thaw Functions**: Deprecate or remove the direct `freeze_mapping` and `thaw_mapping` functions, or make them call `ensure_direct_update_allowed` which will reject them.

3. **Add Rate Limiting**: Even if timelock is added, consider adding rate limiting to prevent rapid freeze/thaw cycles.

## Recommended Code Changes

Add to `TimelockAction` enum:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    // ... existing actions ...
    FreezeMint {
        origin_mint: Pubkey,
    },
    ThawMint {
        origin_mint: Pubkey,
    },
}
```

Add execution logic in `execute_timelock_action`:

```rust
match &entry.action {
    // ... existing actions ...
    TimelockAction::FreezeMint { origin_mint } => {
        let mapping = ctx
            .accounts
            .mint_mapping
            .as_mut()
            .ok_or(FactoryError::TimelockMissingMapping)?;
        require_keys_eq!(
            mapping.origin_mint,
            *origin_mint,
            FactoryError::OriginMintMismatch
        );
        mapping.status = MintStatus::Frozen as u8;
        emit!(MintFrozen {
            origin_mint: mapping.origin_mint,
            authority: state.authority,
        });
    }
    TimelockAction::ThawMint { origin_mint } => {
        let mapping = ctx
            .accounts
            .mint_mapping
            .as_mut()
            .ok_or(FactoryError::TimelockMissingMapping)?;
        require_keys_eq!(
            mapping.origin_mint,
            *origin_mint,
            FactoryError::OriginMintMismatch
        );
        mapping.status = MintStatus::Active as u8;
        emit!(MintThawed {
            origin_mint: mapping.origin_mint,
            authority: state.authority,
        });
    }
}
```

Modify existing functions to require timelock:

```rust
pub fn freeze_mapping(ctx: Context<MutationMintState>) -> Result<()> {
    let state = &ctx.accounts.factory_state;
    ensure_direct_update_allowed(state)?; // This will reject direct calls
    // ... rest of function ...
}
```

## Additional Considerations

- Consider allowing emergency freeze without timelock, but require a longer timelock for thawing.
- Add monitoring and alerting for freeze/thaw operations.
- Consider requiring multiple signatures for freeze operations on critical mints.

