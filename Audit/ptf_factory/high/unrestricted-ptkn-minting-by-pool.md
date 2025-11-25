# Pool-controlled PTKN minting lacks governance guardrails

**Status:** ⚠️ NEW ISSUE

**Severity:** HIGH

**Location:** `programs/factory/src/lib.rs:894-954` (`mint_ptkn`)

## Description

The `mint_ptkn` instruction allows minting new PTKN tokens using the factory PDA as the mint authority but does not require any factory governance signature or timelock. The only gate is that the provided `pool_authority` PDA signs the instruction, which any invocation from the pool program can do via `invoke_signed`. There is no linkage to a queued governance action or per-mint issuance limit beyond the per-call `MAX_MINT_AMOUNT` cap, and no check that the call corresponds to a real shield/unshield flow.

## Code Reference

### `mint_ptkn` (lines 894-954):
```rust
pub fn mint_ptkn(ctx: Context<MintPtkn>, amount: u64) -> Result<()> {
    require!(amount > 0, FactoryError::InvalidAmount);
    require!(amount <= ptf_factory::MAX_MINT_AMOUNT, FactoryError::AmountTooLarge);
    let factory_state = &ctx.accounts.factory_state;
    require!(!factory_state.paused, FactoryError::Paused);
    let mapping = &ctx.accounts.mint_mapping;
    require!(mapping.has_ptkn, FactoryError::PtknMintDisabled);
    require!(mapping.status == MintStatus::Active as u8, FactoryError::MintFrozen);
    // ... pool PDA check ...
    require!(ctx.accounts.pool_authority.is_signer, FactoryError::PoolAuthorityMismatch);
    // mints using factory_state PDA as authority with signer seeds
    token_interface::mint_to(cpi_ctx, amount)?;
    Ok(())
}
```

## Issue

Because no factory authority signature or timelock approval is required, the pool program can mint arbitrary PTKN supply at will as long as it signs with its PDA. A compromised or maliciously upgraded pool program could inflate PTKN without any governance oversight, bypassing fee controls or supply accounting. Even honest pool logic has no on-chain enforcement tying PTKN issuance to actual deposits, so any bug allowing an attacker to trigger `mint_ptkn` would immediately produce free tokens.

## Impact

- **Attack scenario:** An attacker exploits any flaw in the pool program that lets them trigger `mint_ptkn` via CPI, or a malicious pool upgrade simply calls it directly, minting up to `MAX_MINT_AMOUNT` per call repeatedly.
- **Potential loss:** Unlimited PTKN inflation devalues user holdings and enables draining downstream liquidity or redemption flows.
- **Likelihood:** Medium. Only the pool program can satisfy the PDA signer requirement, but any pool logic bug or upgrade path exposes this capability with no further guardrails.

## Attack Scenario

1. Attacker finds a CPI path in the pool program (or deploys an upgraded pool) that invokes `factory::mint_ptkn` with the pool PDA seeds.
2. The factory accepts the call because only `pool_authority.is_signer` is required; no factory authority signature or timelock approval is checked.
3. Attacker mints arbitrary PTKN into their token account, bypassing deposit requirements and inflating supply.

## Current Mitigations

- Per-call cap `MAX_MINT_AMOUNT` limits individual mint size but can be looped.
- Factory pause halts minting but provides no pre-issuance approval.

## Recommendation

Require explicit factory governance approval for PTKN issuance, or enforce issuance coupling to shielded deposits:

- Add a factory authority signer (or timelock entry) requirement to `mint_ptkn` so only approved governance actions can mint.
- Alternatively, track minted supply per pool and only allow minting when correlated to verified pool actions (e.g., shield events) proven via signed receipts.

### Suggested Fix:
```rust
pub fn mint_ptkn(ctx: Context<MintPtkn>, amount: u64) -> Result<()> {
    require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.factory_state.authority, FactoryError::Unauthorized);
    require!(ctx.accounts.authority.is_signer, FactoryError::Unauthorized);
    // optionally require a queued timelock entry or issuance allowance here
    // existing checks ...
}

#[derive(Accounts)]
pub struct MintPtkn<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    // existing accounts ...
}
```
