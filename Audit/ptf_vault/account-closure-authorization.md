# Account Closure Authorization

**Severity**: MEDIUM

## Description

The vault program closes `PendingAuthorityChange` accounts in `execute_authority_change` and `cancel_authority_change`, but the closure authorization could be improved. In `execute_authority_change`, anyone can execute (which is correct), but they receive the rent from closing the account, which could be an incentive for malicious execution.

## Vulnerability Details

The `ExecuteAuthorityChange` struct closes the pending_change account to the executor:

```317:334:programs/vault/src/lib.rs
#[derive(Accounts)]
pub struct ExecuteAuthorityChange<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.vault_state == vault_state.key() @ VaultError::VaultMismatch,
        close = executor,  // Executor receives rent
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    #[account(mut)]
    pub executor: Signer<'info>,
}
```

The `CancelAuthorityChange` struct closes to the authority:

```336:352:programs/vault/src/lib.rs
#[derive(Accounts)]
pub struct CancelAuthorityChange<'info> {
    #[account(seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.vault_state == vault_state.key() @ VaultError::VaultMismatch,
        close = authority,  // Authority receives rent
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
}
```

Potential issues:
1. **Rent Incentive**: Executor receives rent, which could incentivize execution of malicious changes
2. **No Validation of Executor**: Anyone can execute, which is correct, but they get rent
3. **Authority Gets Rent on Cancel**: Authority gets rent when canceling, which is fine but worth noting

## Exploitation Scenario

1. **Rent Extraction Attack**: 
   - Attacker proposes authority change to their own authority
   - After timelock, attacker executes change
   - Attacker receives rent from closing account
   - Small financial gain, but could be part of larger attack

2. **Front-Running Execution**: 
   - Legitimate authority change is proposed
   - Attacker front-runs execution to get rent
   - Attacker executes change (which is fine, but gets rent)

3. **Rent Manipulation**: 
   - Attacker creates many pending changes
   - Attacker executes them to collect rent
   - Small DoS or spam attack

## Code References

```329:329:programs/vault/src/lib.rs
close = executor,
```

```349:349:programs/vault/src/lib.rs
close = authority,
```

## Mitigation

1. **Close to System Program**: Close accounts to system program instead of executor:
   ```rust
   close = system_program,
   ```

2. **Close to Vault**: Close to vault PDA instead:
   ```rust
   close = vault_state,
   ```

3. **Don't Close on Execute**: Keep account open, mark as executed, allow cleanup later:
   ```rust
   // Remove close constraint, mark as executed
   pending.executed = true;
   // Add cleanup function that can close expired/executed accounts
   ```

4. **Validate Executor**: While anyone should be able to execute, consider validating executor is reasonable (not a known malicious address).

## Recommended Code Changes

Option 1: Close to system program (rent is burned):

```rust
#[derive(Accounts)]
pub struct ExecuteAuthorityChange<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.vault_state == vault_state.key() @ VaultError::VaultMismatch,
        close = system_program,  // CRITICAL FIX: Close to system program, rent is burned
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
    #[account(mut)]
    pub executor: Signer<'info>,
}
```

Option 2: Don't close, add cleanup function:

```rust
#[derive(Accounts)]
pub struct ExecuteAuthorityChange<'info> {
    // ... existing accounts ...
    // Remove close constraint
    pub pending_change: Account<'info, PendingAuthorityChange>,
    #[account(mut)]
    pub executor: Signer<'info>,
}

pub fn execute_authority_change(
    ctx: Context<ExecuteAuthorityChange>,
) -> Result<()> {
    // ... validation ...
    
    // Mark as executed but don't close
    pending.executed = true;
    state.pool_authority = pending.new_authority;
    
    // ... emit event ...
    Ok(())
}

// New cleanup function
pub fn cleanup_executed_change(
    ctx: Context<CleanupExecutedChange>,
) -> Result<()> {
    let pending = &ctx.accounts.pending_change;
    require!(pending.executed, VaultError::NotExecuted);
    
    // Close to system program or vault
    // This is handled by Anchor's close constraint
    Ok(())
}

#[derive(Accounts)]
pub struct CleanupExecutedChange<'info> {
    #[account(seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump = pending_change.bump,
        constraint = pending_change.executed @ VaultError::NotExecuted,
        close = system_program,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
    #[account(mut)]
    pub cleaner: Signer<'info>,
}
```

## Additional Considerations

- Consider whether rent should go to executor (incentive for execution) or be burned.
- Add monitoring for frequent executions (potential spam).
- Consider requiring a small fee for execution to prevent spam.
- Document the rent handling behavior.

