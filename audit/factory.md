# PTF Factory Program Audit

## Medium Findings

1. **`freeze_mapping` does not propagate to the pool**  
   Factory governance can call `freeze_mapping`/`thaw_mapping` to flip `MintMapping.status`:

```150:167:programs/factory/src/lib.rs
    pub fn freeze_mapping(ctx: Context<MutationMintState>) -> Result<()> {
        let mapping = &mut ctx.accounts.mint_mapping;
        mapping.status = MintStatus::Frozen as u8;
        emit!(MintFrozen { .. });
    }

    pub fn thaw_mapping(ctx: Context<MutationMintState>) -> Result<()> {
        let mapping = &mut ctx.accounts.mint_mapping;
        mapping.status = MintStatus::Active as u8;
        emit!(MintThawed { .. });
    }
```
   Unfortunately, `ptf_pool` never reads `MintMapping.status`, so freezing a mint has **zero effect** on shield/unshield flows. This creates a false sense of control for operators who expect freezes to halt activity in emergencies. **Recommendation:** have the pool program enforce `status == Active` (see pool report) or remove the freeze instructions until downstream consumers honour them.

## Low Findings / Improvements

- The timelock stores an `action_hash` but `execute_timelock_action` never verifies it, so any latent account-corruption bug would go undetected. Recomputing the hash at execution would add defence in depth.
- `prepare_ptkn_mint` repeatedly deserialises the mint to fetch decimals and authority; caching the state after the first read would save CU during upgrades.
