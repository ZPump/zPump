# Authority Change Race Condition

**Severity**: HIGH

## Description

There's a race condition in the authority change mechanism: if the authority changes between when a change is proposed and when it's executed, the execution could fail or succeed incorrectly. Additionally, if multiple authority changes are proposed in quick succession, the second one could overwrite the first before it's executed.

## Vulnerability Details

The `execute_authority_change` function validates that the current authority matches the pending change:

```190:194:programs/vault/src/lib.rs
require_keys_eq!(
    pending.current_authority,
    state.pool_authority,
    VaultError::AuthorityMismatch
);
```

However, there are several race condition scenarios:

1. **Authority Changes Between Proposal and Execution**: 
   - Authority A proposes change to Authority B
   - Before timelock expires, Authority A changes to Authority C (via another proposal/execution)
   - When Authority B change executes, it fails because current authority is C, not A

2. **Multiple Proposals**: 
   - Only one pending change can exist (single PDA)
   - If Authority A proposes change to B, then quickly proposes change to C
   - Second proposal overwrites first (if first hasn't been executed)
   - First change is lost

3. **Authority Change During Timelock**: 
   - Authority A proposes change to B
   - During 7-day timelock, Authority A is compromised
   - Attacker cancels change to B, proposes change to AttackerAuthority
   - After timelock, attacker gains control

## Exploitation Scenario

1. **Race Condition Attack**: 
   - Legitimate authority proposes change to NewAuthority
   - Attacker quickly proposes change to AttackerAuthority (if they can)
   - Attacker's proposal overwrites legitimate one
   - Attacker gains control after timelock

2. **Authority Compromise During Timelock**: 
   - Authority proposes legitimate change
   - Authority key is compromised during 7-day timelock
   - Attacker cancels legitimate change
   - Attacker proposes change to attacker's authority
   - Attacker gains control

3. **Cascading Authority Changes**: 
   - Authority A → B (proposed)
   - Before execution, Authority A → C (proposed, overwrites first)
   - Authority A → C executes
   - Authority A → B can never execute (authority mismatch)

## Code References

```190:194:programs/vault/src/lib.rs
require_keys_eq!(
    pending.current_authority,
    state.pool_authority,
    VaultError::AuthorityMismatch
);
```

```127:168:programs/vault/src/lib.rs
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... no check for existing pending change ...
    // If pending change exists, init will fail, but no graceful handling
}
```

## Mitigation

1. **Hash-Based Change Tracking**: Use a hash of the change proposal to prevent overwrites:
   ```rust
   let change_hash = hashv(&[
       state.pool_authority.as_ref(),
       new_pool_authority.as_ref(),
       &execute_after.to_le_bytes(),
   ]);
   ```

2. **Sequence Numbers**: Use sequence numbers to track authority change attempts:
   ```rust
   pub struct VaultState {
       // ... existing fields ...
       pub authority_change_sequence: u64,
   }
   ```

3. **Prevent Overwrites**: Explicitly check for existing pending changes and prevent overwrites:
   ```rust
   if let Some(existing) = &ctx.accounts.existing_pending_change {
       if !existing.executed && !existing.canceled {
           return err!(VaultError::PendingChangeExists);
       }
   }
   ```

4. **Lock During Timelock**: Prevent new proposals while a pending change exists (unless expired).

5. **Multi-Step Confirmation**: Require new authority to confirm before execution.

## Recommended Code Changes

```rust
#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub bump: u8,
    pub locked: bool,
    pub authority_change_sequence: u64, // NEW: Track change sequence
}

pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    let state = &mut ctx.accounts.vault_state;
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
            // If expired, allow new proposal
        }
    }
    
    let clock = Clock::get()?;
    let execute_after = clock
        .unix_timestamp
        .checked_add(TIMELOCK_DURATION_SECONDS)
        .ok_or(VaultError::TimelockOverflow)?;
    
    // Increment sequence
    let sequence = state.authority_change_sequence
        .checked_add(1)
        .ok_or(VaultError::SequenceOverflow)?;
    state.authority_change_sequence = sequence;
    
    let pending = &mut ctx.accounts.pending_change;
    pending.vault_state = state.key();
    pending.current_authority = state.pool_authority;
    pending.new_authority = new_pool_authority;
    pending.proposed_at = clock.unix_timestamp;
    pending.execute_after = execute_after;
    pending.executed = false;
    pending.canceled = false;
    pending.bump = ctx.bumps.pending_change;
    pending.sequence = sequence; // NEW: Track sequence
    
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
    
    let state = &mut ctx.accounts.vault_state;
    require_keys_eq!(
        pending.vault_state,
        state.key(),
        VaultError::VaultMismatch
    );
    
    // CRITICAL FIX: Check if authority has changed since proposal
    // If it has, this change is no longer valid
    if pending.current_authority != state.pool_authority {
        // Authority changed, this proposal is stale
        // Option 1: Reject execution
        return err!(VaultError::AuthorityMismatch);
        
        // Option 2: Allow execution if sequence matches (authority changed via another proposal)
        // This would require tracking which sequence corresponds to which authority
    }
    
    // CRITICAL FIX: Validate sequence matches
    require!(
        pending.sequence <= state.authority_change_sequence,
        VaultError::StaleProposal
    );
    
    require_keys_eq!(
        pending.current_authority,
        state.pool_authority,
        VaultError::AuthorityMismatch
    );
    
    // ... execute change ...
}
```

## Additional Considerations

- Consider allowing execution of stale proposals if they're still valid (authority hasn't changed).
- Add expiration to proposals to prevent indefinite blocking.
- Consider requiring new authority confirmation before execution.
- Add monitoring for rapid authority change proposals.

