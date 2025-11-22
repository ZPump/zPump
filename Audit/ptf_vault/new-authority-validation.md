# New Authority Validation in Authority Change

**Severity**: HIGH

## Description

The `propose_authority_change` function accepts any `new_pool_authority` without validating that it's actually a valid pool program PDA. This allows proposing authority changes to invalid or malicious authorities, potentially compromising the vault.

## Vulnerability Details

The `propose_authority_change` function only checks that the new authority is different from the current one:

```127:168:programs/vault/src/lib.rs
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    let state = &ctx.accounts.vault_state;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.pool_authority,
        VaultError::UnauthorizedCaller
    );
    require!(
        new_pool_authority != state.pool_authority,
        VaultError::InvalidAuthorityChange
    );
    
    // ... creates pending change without validating new_pool_authority ...
}
```

There's no validation that:
1. `new_pool_authority` is actually a PDA derived from the pool program
2. `new_pool_authority` is owned by `PTF_POOL_PROGRAM_ID`
3. `new_pool_authority` corresponds to a valid pool for the given `origin_mint`
4. `new_pool_authority` is not the default/null pubkey

## Exploitation Scenario

1. **Malicious Authority Change**: An attacker who compromises the current authority could propose a change to a malicious authority:
   - Attacker creates a fake pool program
   - Attacker proposes change to fake pool authority
   - After 7-day timelock, attacker executes change
   - Attacker gains control of vault

2. **Invalid Authority**: A legitimate authority could accidentally propose a change to an invalid authority:
   - Authority proposes change to wrong pubkey
   - After timelock, change is executed
   - Vault becomes unusable (no valid authority can release tokens)

3. **Default Pubkey Attack**: An attacker could propose a change to `Pubkey::default()`:
   - Authority change to default pubkey
   - After execution, no valid authority exists
   - Vault becomes permanently locked

4. **Wrong Mint Authority**: An attacker could propose a change to a pool authority for a different mint:
   - Vault for TokenA, propose change to TokenB's pool authority
   - After execution, wrong authority controls vault
   - Causes confusion and potential security issues

## Code References

```127:168:programs/vault/src/lib.rs
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... validation of current authority ...
    require!(
        new_pool_authority != state.pool_authority,
        VaultError::InvalidAuthorityChange
    );
    // ... no validation of new_pool_authority ...
}
```

## Mitigation

1. **Validate New Authority**: Add validation in `propose_authority_change` to ensure `new_pool_authority` is valid:
   - Verify it's not `Pubkey::default()`
   - Verify it's owned by `PTF_POOL_PROGRAM_ID` (if possible to check)
   - Optionally verify it's derived from the correct seeds for the origin_mint
   - Verify it's a PDA (not a regular account)

2. **Require New Authority Account**: Instead of accepting a `Pubkey`, require the new pool authority as an account and validate it:
   - Check ownership
   - Verify it matches expected derivation for origin_mint

3. **Derive Expected Authority**: Derive the expected pool authority from origin_mint and compare:
   - Use `Pubkey::find_program_address` to derive expected pool authority
   - Compare with provided authority
   - Reject if mismatch (unless allowing cross-mint authority changes is intentional)

## Recommended Code Changes

```rust
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    let state = &ctx.accounts.vault_state;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.pool_authority,
        VaultError::UnauthorizedCaller
    );
    require!(
        new_pool_authority != state.pool_authority,
        VaultError::InvalidAuthorityChange
    );
    
    // CRITICAL FIX: Validate new authority is not default
    require!(
        new_pool_authority != Pubkey::default(),
        VaultError::InvalidAuthorityChange
    );
    
    // CRITICAL FIX: Validate new authority is valid pool PDA
    // Derive expected pool authority for this mint
    let (expected_pool_authority, _) = Pubkey::find_program_address(
        &[seeds::POOL, state.origin_mint.as_ref()],
        &PTF_POOL_PROGRAM_ID,
    );
    
    // Option 1: Require exact match (strict)
    require_keys_eq!(
        new_pool_authority,
        expected_pool_authority,
        VaultError::InvalidAuthorityChange
    );
    
    // Option 2: Or validate it's owned by pool program (if account is provided)
    // This would require changing the function signature to accept AccountInfo
    
    let clock = Clock::get()?;
    let execute_after = clock
        .unix_timestamp
        .checked_add(TIMELOCK_DURATION_SECONDS)
        .ok_or(VaultError::TimelockOverflow)?;
    
    let pending = &mut ctx.accounts.pending_change;
    pending.vault_state = state.key();
    pending.current_authority = state.pool_authority;
    pending.new_authority = new_pool_authority;
    pending.proposed_at = clock.unix_timestamp;
    pending.execute_after = execute_after;
    pending.executed = false;
    pending.canceled = false;
    pending.bump = ctx.bumps.pending_change;
    
    emit!(AuthorityChangeProposed {
        vault_state: state.key(),
        origin_mint: state.origin_mint,
        current_authority: state.pool_authority,
        new_authority: new_pool_authority,
        proposed_at: clock.unix_timestamp,
        execute_after,
    });
    
    Ok(())
}
```

Alternative: Require new authority as account:

```rust
#[derive(Accounts)]
pub struct ProposeAuthorityChange<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: New pool authority must be a valid pool PDA
    #[account(
        constraint = new_pool_authority.owner == &PTF_POOL_PROGRAM_ID @ VaultError::InvalidAuthorityChange
    )]
    pub new_pool_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump,
        space = PendingAuthorityChange::SPACE,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
}

pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
) -> Result<()> {
    // ... existing validation ...
    
    // Validate new authority matches expected derivation
    let (expected_pool_authority, _) = Pubkey::find_program_address(
        &[seeds::POOL, ctx.accounts.vault_state.origin_mint.as_ref()],
        &PTF_POOL_PROGRAM_ID,
    );
    
    require_keys_eq!(
        ctx.accounts.new_pool_authority.key(),
        expected_pool_authority,
        VaultError::InvalidAuthorityChange
    );
    
    // ... rest of function ...
}
```

## Additional Considerations

- Consider whether cross-mint authority changes should be allowed (e.g., migrating vault to a different pool).
- Add validation in `execute_authority_change` as well to double-check the new authority is valid.
- Consider requiring the new authority to confirm the change before execution.
- Add events to log authority validation failures.


