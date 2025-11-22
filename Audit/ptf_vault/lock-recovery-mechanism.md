# Missing Lock Recovery Mechanism

**Severity**: MEDIUM

## Description

The vault program uses a `locked` flag as a reentrancy guard, but there's no mechanism to recover if the lock becomes stuck (e.g., due to a transaction failure, account corruption, or edge case). If the lock remains set to `true`, all deposit and release operations will be permanently blocked, causing a DoS.

## Vulnerability Details

The vault uses a `locked` boolean flag for reentrancy protection:

```354:360:programs/vault/src/lib.rs
#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub bump: u8,
    pub locked: bool, // Reentrancy guard
}
```

The lock is set before external calls and released after:

```33:57:programs/vault/src/lib.rs
// REENTRANCY GUARD: Check and set lock before any external calls
require!(!vault_state.locked, VaultError::ReentrancyDetected);
vault_state.locked = true;

// ... external call ...

vault_state.locked = false; // Always release lock
transfer_result?; // Propagate error after releasing lock
```

However, if the lock becomes stuck:
1. All deposit operations will fail with `ReentrancyDetected`
2. All release operations will fail with `ReentrancyDetected`
3. There's no way to reset the lock
4. Vault becomes permanently unusable

## Exploitation Scenario

1. **Transaction Failure Edge Case**: 
   - Transaction sets `locked = true`
   - Transaction fails in an unexpected way before releasing lock
   - Lock remains stuck (though code tries to always release it)
   - Vault becomes unusable

2. **Account Data Corruption**: 
   - Account data becomes corrupted (e.g., due to bug or attack)
   - `locked` flag is set to `true` incorrectly
   - No way to recover without program upgrade

3. **Concurrent Transaction Issue**: 
   - Multiple transactions interact with vault simultaneously
   - Edge case causes lock to not be released properly
   - Lock becomes stuck

4. **Program Bug**: 
   - Bug in lock management code
   - Lock not released in all code paths
   - Vault becomes permanently locked

## Code References

```33:57:programs/vault/src/lib.rs
// REENTRANCY GUARD: Check and set lock before any external calls
require!(!vault_state.locked, VaultError::ReentrancyDetected);
vault_state.locked = true;

// ... external call ...

vault_state.locked = false; // Always release lock
transfer_result?; // Propagate error after releasing lock
```

```77:113:programs/vault/src/lib.rs
// REENTRANCY GUARD: Check and set lock before any external calls
require!(!vault_state.locked, VaultError::ReentrancyDetected);
vault_state.locked = true;

// ... external call ...

vault_state.locked = false; // Always release lock
transfer_result?; // Propagate error after releasing lock
```

## Mitigation

1. **Lock Recovery Function**: Add an authorized function to reset the lock:
   ```rust
   pub fn recover_lock(ctx: Context<RecoverLock>) -> Result<()> {
       require_keys_eq!(
           ctx.accounts.authority.key(),
           ctx.accounts.vault_state.pool_authority,
           VaultError::UnauthorizedCaller
       );
       
       let state = &mut ctx.accounts.vault_state;
       if state.locked {
           msg!("WARNING: Recovering stuck lock");
           state.locked = false;
       }
       Ok(())
   }
   ```

2. **Lock Timeout**: Implement a timeout mechanism that automatically releases locks after a certain time:
   ```rust
   pub struct VaultState {
       // ... existing fields ...
       pub lock_timestamp: Option<i64>, // When lock was acquired
   }
   
   const LOCK_TIMEOUT_SECONDS: i64 = 300; // 5 minutes
   
   fn acquire_lock(state: &mut VaultState) -> Result<()> {
       let clock = Clock::get()?;
       
       if state.locked {
           if let Some(lock_time) = state.lock_timestamp {
               if clock.unix_timestamp > lock_time + LOCK_TIMEOUT_SECONDS {
                   // Lock timed out, release it
                   msg!("WARNING: Lock timeout, releasing");
                   state.locked = false;
                   state.lock_timestamp = None;
               } else {
                   return err!(VaultError::ReentrancyDetected);
               }
           } else {
               // Locked but no timestamp (corrupted), reset
               msg!("WARNING: Corrupted lock state, resetting");
               state.locked = false;
           }
       }
       
       state.locked = true;
       state.lock_timestamp = Some(clock.unix_timestamp);
       Ok(())
   }
   ```

3. **Lock State Validation**: Validate lock state on entry and reset if corrupted.

4. **Enhanced Logging**: Log all lock acquisitions and releases for monitoring.

## Recommended Code Changes

```rust
#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub bump: u8,
    pub locked: bool,
    pub lock_timestamp: Option<i64>, // NEW: Track when lock was acquired
}

const LOCK_TIMEOUT_SECONDS: i64 = 300; // 5 minutes

fn acquire_lock(state: &mut VaultState) -> Result<()> {
    let clock = Clock::get()?;
    
    if state.locked {
        if let Some(lock_time) = state.lock_timestamp {
            if clock.unix_timestamp > lock_time + LOCK_TIMEOUT_SECONDS {
                // Lock timed out, release it
                msg!("WARNING: Lock timeout detected, releasing lock");
                state.locked = false;
                state.lock_timestamp = None;
            } else {
                return err!(VaultError::ReentrancyDetected);
            }
        } else {
            // Locked but no timestamp (corrupted state), reset
            msg!("WARNING: Corrupted lock state detected, resetting");
            state.locked = false;
        }
    }
    
    state.locked = true;
    state.lock_timestamp = Some(clock.unix_timestamp);
    Ok(())
}

fn release_lock(state: &mut VaultState) {
    state.locked = false;
    state.lock_timestamp = None;
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidDepositAmount);
    
    let vault_state = &mut ctx.accounts.vault_state;
    acquire_lock(vault_state)?;
    
    // Use defer-like pattern to ensure lock is always released
    let result = (|| -> Result<()> {
        // ... deposit logic ...
        Ok(())
    })();
    
    release_lock(vault_state);
    result
}

// Lock recovery function
pub fn recover_lock(ctx: Context<RecoverLock>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.vault_state.pool_authority,
        VaultError::UnauthorizedCaller
    );
    
    let state = &mut ctx.accounts.vault_state;
    if state.locked {
        msg!("Recovering stuck lock");
        release_lock(state);
        emit!(LockRecovered {
            vault_state: state.key(),
            recovered_at: Clock::get()?.unix_timestamp,
            authority: ctx.accounts.authority.key(),
        });
    }
    
    Ok(())
}

#[derive(Accounts)]
pub struct RecoverLock<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

#[event]
pub struct LockRecovered {
    pub vault_state: Pubkey,
    pub recovered_at: i64,
    pub authority: Pubkey,
}
```

## Additional Considerations

- Consider requiring multi-sig for lock recovery to prevent abuse.
- Add monitoring and alerting for lock timeouts and recoveries.
- Document the lock recovery process for operators.
- Consider adding a maximum lock duration constant.

