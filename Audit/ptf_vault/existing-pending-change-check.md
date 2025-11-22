# Missing Check for Existing Pending Authority Change

**Severity**: MEDIUM

## Description

The `propose_authority_change` function doesn't explicitly check if a pending authority change already exists before attempting to create a new one. While Anchor's `init` constraint will fail if the account exists, this results in a generic error rather than a clear message, and doesn't provide an opportunity to handle the existing change (e.g., cancel it first).

## Vulnerability Details

The `propose_authority_change` function uses `init` constraint which will fail if the account already exists:

```303:313:programs/vault/src/lib.rs
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
```

However, there's no explicit check in the function logic:

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
    
    // ... no check for existing pending change ...
}
```

If a pending change exists:
1. The `init` constraint will fail with a generic Anchor error
2. No clear error message indicating why the proposal failed
3. No opportunity to cancel the existing change first
4. User experience is poor

## Exploitation Scenario

1. **Poor User Experience**: 
   - User tries to propose authority change
   - Transaction fails with unclear error
   - User doesn't know why or how to fix it
   - Requires manual investigation to find existing pending change

2. **Stale Change Blocking**: 
   - Pending change exists but is expired or forgotten
   - User can't propose new change
   - No way to see or handle existing change in same transaction

3. **Race Condition**: 
   - Two transactions try to propose changes simultaneously
   - One succeeds, one fails with unclear error
   - No way to handle this gracefully

## Code References

```127:168:programs/vault/src/lib.rs
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... validation ...
    // ... no check for existing pending change ...
    let pending = &mut ctx.accounts.pending_change;
    // ... creates new pending change ...
}
```

```303:313:programs/vault/src/lib.rs
#[account(
    init,  // Will fail if account exists
    payer = authority,
    seeds = [
        b"pending-auth",
        vault_state.key().as_ref()
    ],
    bump,
    space = PendingAuthorityChange::SPACE,
)]
pub pending_change: Account<'info, PendingAuthorityChange>,
```

## Mitigation

1. **Explicit Check**: Add an explicit check for existing pending change and provide a clear error:
   ```rust
   // Try to load existing pending change
   if let Ok(existing) = ctx.accounts.existing_pending_change.as_ref() {
       if !existing.executed && !existing.canceled {
           return err!(VaultError::PendingChangeExists);
       }
   }
   ```

2. **Allow Replacement**: Allow replacing existing pending changes:
   - Check if existing change is expired
   - If expired, allow new proposal (close old account first)
   - If not expired, require canceling first

3. **Better Error Messages**: Provide clear error messages when init fails due to existing account.

4. **Optional Account**: Make pending_change optional and check if it exists:
   ```rust
   pub existing_pending_change: Option<Account<'info, PendingAuthorityChange>>,
   ```

## Recommended Code Changes

Option 1: Explicit check with optional account:

```rust
#[derive(Accounts)]
pub struct ProposeAuthorityChange<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Optional existing pending change
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
    )]
    pub existing_pending_change: Option<Account<'info, PendingAuthorityChange>>,
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
    
    // CRITICAL FIX: Check for existing pending change
    if let Some(existing) = &ctx.accounts.existing_pending_change {
        if !existing.executed && !existing.canceled {
            // Check if expired
            let clock = Clock::get()?;
            let expiration = existing.execute_after
                .checked_add(30 * 24 * 60 * 60) // 30 days
                .ok_or(VaultError::TimelockOverflow)?;
            
            if clock.unix_timestamp < expiration {
                return err!(VaultError::PendingChangeExists);
            }
            // If expired, allow new proposal (old account will be closed)
        }
    }
    
    // ... rest of function ...
}
```

Option 2: Use `init_if_needed` and check state:

```rust
#[account(
    init_if_needed,
    payer = authority,
    seeds = [
        b"pending-auth",
        vault_state.key().as_ref()
    ],
    bump,
    space = PendingAuthorityChange::SPACE,
)]
pub pending_change: Account<'info, PendingAuthorityChange>,

pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... validation ...
    
    let pending = &mut ctx.accounts.pending_change;
    
    // CRITICAL FIX: Check if account was just initialized or already existed
    if pending.vault_state != Pubkey::default() {
        // Account already exists, check state
        require!(
            pending.executed || pending.canceled,
            VaultError::PendingChangeExists
        );
        // Reset for new proposal
        pending.executed = false;
        pending.canceled = false;
    }
    
    // ... set fields ...
}
```

## Additional Considerations

- Consider adding a function to query existing pending changes.
- Add events to log when proposals are blocked by existing changes.
- Consider allowing batch operations (cancel + propose in same transaction).
- Document the behavior when pending changes exist.

