# No Expiration on Pending Authority Changes

**Severity**: MEDIUM

## Description

Pending authority changes don't have an expiration mechanism. Once a change is proposed, it can remain pending indefinitely if not executed or canceled. This could lead to stale proposals blocking new changes or causing confusion.

## Vulnerability Details

The `PendingAuthorityChange` struct tracks when a change can be executed (`execute_after`) but doesn't have an expiration:

```369:378:programs/vault/src/lib.rs
#[account]
pub struct PendingAuthorityChange {
    pub vault_state: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,
    pub executed: bool,
    pub canceled: bool,
    pub bump: u8,
}
```

Issues:
1. **No Expiration**: Pending changes can remain valid indefinitely
2. **Stale Proposals**: Old proposals that are no longer desired remain executable
3. **Blocking New Proposals**: Stale proposals can block new proposals (single PDA limitation)
4. **Confusion**: Users might execute old proposals by mistake

## Exploitation Scenario

1. **Stale Proposal Execution**: 
   - Authority proposes change to NewAuthority
   - Later decides against it, but doesn't cancel
   - Years later, someone executes the old proposal
   - Authority changes unexpectedly

2. **Blocking New Proposals**: 
   - Old proposal exists but is forgotten
   - New proposal can't be created (single PDA)
   - Vault governance is blocked

3. **Accidental Execution**: 
   - Multiple old proposals exist (if sequence system is used)
   - User accidentally executes wrong/old proposal
   - Unintended authority change

## Code References

```369:378:programs/vault/src/lib.rs
#[account]
pub struct PendingAuthorityChange {
    pub vault_state: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,  // When can execute, but no expiration
    pub executed: bool,
    pub canceled: bool,
    pub bump: u8,
}
```

```179:182:programs/vault/src/lib.rs
require!(
    clock.unix_timestamp >= pending.execute_after,
    VaultError::TimelockNotReady
);
// No check for expiration
```

## Mitigation

1. **Add Expiration Field**: Add `expires_at` field to `PendingAuthorityChange`:
   ```rust
   pub struct PendingAuthorityChange {
       // ... existing fields ...
       pub expires_at: i64, // When proposal expires
   }
   ```

2. **Check Expiration on Execute**: Reject execution if proposal is expired:
   ```rust
   require!(
       clock.unix_timestamp < pending.expires_at,
       VaultError::ChangeExpired
   );
   ```

3. **Auto-Expire**: Automatically mark as expired after reasonable time (e.g., 30 days after `execute_after`).

4. **Cleanup Expired**: Allow cleanup of expired proposals.

## Recommended Code Changes

```rust
#[account]
pub struct PendingAuthorityChange {
    pub vault_state: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,
    pub expires_at: i64, // NEW: Expiration timestamp
    pub executed: bool,
    pub canceled: bool,
    pub bump: u8,
}

impl PendingAuthorityChange {
    // Update SPACE calculation to include expires_at (8 bytes)
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 7;
}

const PENDING_CHANGE_EXPIRATION_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... existing validation ...
    
    let clock = Clock::get()?;
    let execute_after = clock
        .unix_timestamp
        .checked_add(TIMELOCK_DURATION_SECONDS)
        .ok_or(VaultError::TimelockOverflow)?;
    
    // CRITICAL FIX: Set expiration (30 days after execution time)
    let expires_at = execute_after
        .checked_add(PENDING_CHANGE_EXPIRATION_SECONDS)
        .ok_or(VaultError::TimelockOverflow)?;
    
    let pending = &mut ctx.accounts.pending_change;
    pending.vault_state = state.key();
    pending.current_authority = state.pool_authority;
    pending.new_authority = new_pool_authority;
    pending.proposed_at = clock.unix_timestamp;
    pending.execute_after = execute_after;
    pending.expires_at = expires_at; // NEW
    pending.executed = false;
    pending.canceled = false;
    pending.bump = ctx.bumps.pending_change;
    
    // ... emit event ...
    Ok(())
}

pub fn execute_authority_change(
    ctx: Context<ExecuteAuthorityChange>,
) -> Result<()> {
    let pending = &mut ctx.accounts.pending_change;
    require!(!pending.executed, VaultError::AlreadyExecuted);
    require!(!pending.canceled, VaultError::ChangeCanceled);
    
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= pending.execute_after,
        VaultError::TimelockNotReady
    );
    
    // CRITICAL FIX: Check expiration
    require!(
        clock.unix_timestamp < pending.expires_at,
        VaultError::ChangeExpired
    );
    
    // ... rest of execution logic ...
}

pub fn cleanup_expired_change(
    ctx: Context<CleanupExpiredChange>,
) -> Result<()> {
    let pending = &ctx.accounts.pending_change;
    let clock = Clock::get()?;
    
    require!(
        clock.unix_timestamp >= pending.expires_at,
        VaultError::ChangeNotExpired
    );
    require!(!pending.executed, VaultError::AlreadyExecuted);
    require!(!pending.canceled, VaultError::AlreadyCanceled);
    
    // Close account (handled by Anchor's close constraint)
    emit!(ExpiredChangeCleaned {
        vault_state: pending.vault_state,
        cleaned_at: clock.unix_timestamp,
    });
    
    Ok(())
}

#[derive(Accounts)]
pub struct CleanupExpiredChange<'info> {
    #[account(seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.vault_state == vault_state.key() @ VaultError::VaultMismatch,
        constraint = Clock::get().unwrap().unix_timestamp >= pending_change.expires_at @ VaultError::ChangeNotExpired,
        close = system_program,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
    #[account(mut)]
    pub cleaner: Signer<'info>,
}

#[error_code]
pub enum VaultError {
    // ... existing errors ...
    #[msg("E_CHANGE_EXPIRED")]
    ChangeExpired,
    #[msg("E_CHANGE_NOT_EXPIRED")]
    ChangeNotExpired,
}
```

## Additional Considerations

- Consider making expiration configurable (e.g., via timelock).
- Add monitoring and alerting for expiring proposals.
- Consider automatic expiration checking in propose function.
- Document expiration behavior for users.

