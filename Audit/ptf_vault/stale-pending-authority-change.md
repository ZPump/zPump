# Stale Pending Authority Change Blocking

**Severity**: MEDIUM

## Description

The vault program only allows one pending authority change at a time (single PDA per vault). If a pending change is proposed but never executed or canceled, it blocks all future authority change proposals. There's no cleanup mechanism for stale pending changes, potentially causing permanent DoS.

## Vulnerability Details

The `PendingAuthorityChange` account uses a single PDA per vault:

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

This means:
1. Only one pending change can exist per vault
2. If a pending change is never executed or canceled, new proposals are blocked
3. There's no expiration or cleanup mechanism for stale pending changes
4. If the authority is lost/compromised, they can't cancel, and no one else can propose a new change

## Exploitation Scenario

1. **Stale Change Blocking**: 
   - Legitimate authority proposes a change
   - Authority key is lost before execution
   - Pending change cannot be canceled (requires authority signature)
   - New authority change proposals are blocked forever
   - Vault becomes ungovernable

2. **Malicious Blocking**:
   - Attacker compromises authority
   - Attacker proposes change to malicious authority
   - Attacker loses key or abandons attack
   - Pending change blocks legitimate authority changes
   - Vault is stuck

3. **Accidental Blocking**:
   - Authority proposes change but forgets about it
   - Change expires (timelock passes) but account still exists
   - New proposals blocked
   - Requires manual intervention (if possible)

## Code References

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

```127:168:programs/vault/src/lib.rs
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... no check for existing pending change ...
    // If pending_change account already exists, init will fail
}
```

## Mitigation

1. **Expiration Mechanism**: Add expiration to pending changes. If a change is not executed within a reasonable time (e.g., 30 days after `execute_after`), allow cleanup.

2. **Cleanup Function**: Add a cleanup function that allows removing stale pending changes:
   - Only allow cleanup if change is expired
   - Require appropriate authorization (e.g., current authority or multi-sig)
   - Close the account and refund rent

3. **Multiple Pending Changes**: Use a sequence number or nonce to allow multiple pending changes:
   - Each change gets a unique PDA (include sequence/nonce)
   - Track active pending changes
   - Allow canceling any pending change by current authority

4. **Automatic Expiration**: Automatically mark expired changes as canceled:
   - Check expiration in `propose_authority_change`
   - If existing change is expired, allow new proposal
   - Optionally close expired account

5. **Change Replacement**: Allow replacing pending changes:
   - If pending change exists, allow canceling and creating new one in same transaction
   - Or allow proposing new change if existing one is expired

## Recommended Code Changes

Option 1: Add expiration and cleanup:

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

const PENDING_CHANGE_EXPIRATION_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... existing validation ...
    
    let clock = Clock::get()?;
    
    // Check if existing pending change is expired
    if let Ok(existing) = ctx.accounts.existing_pending_change.as_ref() {
        if clock.unix_timestamp > existing.expires_at && !existing.executed && !existing.canceled {
            // Existing change is expired, allow new proposal
            // Close expired account first
        }
    }
    
    let execute_after = clock
        .unix_timestamp
        .checked_add(TIMELOCK_DURATION_SECONDS)
        .ok_or(VaultError::TimelockOverflow)?;
    
    let expires_at = execute_after
        .checked_add(PENDING_CHANGE_EXPIRATION_SECONDS)
        .ok_or(VaultError::TimelockOverflow)?;
    
    let pending = &mut ctx.accounts.pending_change;
    // ... set fields ...
    pending.expires_at = expires_at;
    
    Ok(())
}

pub fn cleanup_expired_change(
    ctx: Context<CleanupExpiredChange>,
) -> Result<()> {
    let pending = &ctx.accounts.pending_change;
    let clock = Clock::get()?;
    
    require!(
        clock.unix_timestamp > pending.expires_at,
        VaultError::ChangeNotExpired
    );
    require!(!pending.executed, VaultError::AlreadyExecuted);
    require!(!pending.canceled, VaultError::AlreadyCanceled);
    
    // Close account and refund rent
    // This is handled by Anchor's close constraint
    
    emit!(ExpiredChangeCleaned {
        vault_state: pending.vault_state,
        cleaned_at: clock.unix_timestamp,
    });
    
    Ok(())
}
```

Option 2: Use sequence for multiple pending changes:

```rust
#[account]
pub struct VaultState {
    // ... existing fields ...
    pub pending_change_sequence: u64, // Track sequence of pending changes
}

#[account]
pub struct PendingAuthorityChange {
    // ... existing fields ...
    pub sequence: u64, // Sequence number for this change
}

#[derive(Accounts)]
pub struct ProposeAuthorityChange<'info> {
    // ... existing accounts ...
    #[account(
        init,
        payer = authority,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref(),
            &vault_state.pending_change_sequence.to_le_bytes(),
        ],
        bump,
        space = PendingAuthorityChange::SPACE,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
}

pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... validation ...
    
    let state = &mut ctx.accounts.vault_state;
    let sequence = state.pending_change_sequence
        .checked_add(1)
        .ok_or(VaultError::SequenceOverflow)?;
    state.pending_change_sequence = sequence;
    
    let pending = &mut ctx.accounts.pending_change;
    pending.sequence = sequence;
    // ... set other fields ...
    
    Ok(())
}
```

## Additional Considerations

- Consider requiring multi-sig for cleanup operations to prevent abuse.
- Add monitoring and alerting for stale pending changes.
- Consider automatic expiration checking in `propose_authority_change`.
- Document the cleanup process for operators.


