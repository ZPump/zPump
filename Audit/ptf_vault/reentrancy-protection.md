# Reentrancy Protection in Vault

## Severity: HIGH

## Description

The vault program handles token deposits and releases. While Solana's transaction model provides some protection against reentrancy, the vault implements a reentrancy guard (`locked` flag) to prevent recursive calls. However, there are still potential vulnerabilities.

## Vulnerability Details

### Current Implementation

The vault has:
- Reentrancy guard (`locked` flag) in `VaultState`
- Lock set before external calls (deposit/release)
- Lock released after external calls, even on failure

### Potential Vulnerabilities

1. **Lock Release Timing**: The lock is released after the CPI call, but if the CPI fails, the lock is still released. This is correct, but if there's an error in the release logic itself, the lock might not be properly managed.

2. **Concurrent Transactions**: While Solana prevents reentrancy within a single transaction, multiple transactions could potentially interact with the vault simultaneously, and the lock only protects within a transaction.

3. **Lock State Corruption**: If the `locked` flag becomes corrupted (e.g., due to account data manipulation), the reentrancy protection could be bypassed.

4. **Lock Not Checked in All Paths**: If there are code paths that don't check the lock, reentrancy could occur.

5. **Lock Deadlock**: If the lock is set but never released due to an error, the vault could become permanently locked (DoS).

## Exploitation Scenario

```rust
// Scenario 1: Lock bypass
// 1. Attacker finds code path that doesn't check locked flag
// 2. Attacker can call deposit/release recursively
// 3. Attacker drains vault or manipulates balances

// Scenario 2: Lock state corruption
// 1. Attacker manipulates vault account data
// 2. Locked flag is set incorrectly
// 3. Reentrancy protection is bypassed
// 4. Attacker can perform reentrant calls

// Scenario 3: Lock deadlock
// 1. Transaction sets locked = true
// 2. Transaction fails before releasing lock
// 3. Lock is not released (though code tries to)
// 4. Vault becomes permanently locked
// 5. DoS attack on vault operations
```

## Code References

- Reentrancy guard: `VaultState.locked` field (line 359)
- Lock in deposit: Lines 33-35, 56
- Lock in release: Lines 77-79, 112
- Lock release: Always released, even on error (lines 56, 112)

## Mitigation

1. **Comprehensive Lock Checks**: Ensure all code paths that perform external calls check the lock first. Add assertions to verify lock state.

2. **Lock State Validation**: Validate lock state on entry to ensure it's not corrupted. Reset lock if in invalid state (with logging).

3. **Lock Timeout**: Implement a lock timeout mechanism. If a lock is held for too long, automatically release it (with appropriate logging and alerts).

4. **Atomic Lock Management**: Use Solana's account data atomicity to ensure lock state is always consistent.

5. **Lock Recovery Mechanism**: Implement a recovery mechanism to reset locks if they become stuck, with proper authorization.

6. **Enhanced Logging**: Log all lock acquisitions and releases to enable monitoring and detection of anomalies.

7. **Lock Assertions**: Add assertions throughout the code to verify lock state is as expected.

## Recommended Code Changes

```rust
// Enhanced reentrancy guard with timeout
pub struct VaultState {
    // ... existing fields ...
    pub locked: bool,
    pub lock_timestamp: Option<i64>, // Track when lock was acquired
}

const LOCK_TIMEOUT_SECONDS: i64 = 300; // 5 minutes

fn acquire_lock(state: &mut VaultState) -> Result<()> {
    let clock = Clock::get()?;
    
    // Check if already locked
    if state.locked {
        // Check for timeout
        if let Some(lock_time) = state.lock_timestamp {
            if clock.unix_timestamp > lock_time + LOCK_TIMEOUT_SECONDS {
                // Lock timed out, release it (with logging)
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
    
    // Acquire lock
    state.locked = true;
    state.lock_timestamp = Some(clock.unix_timestamp);
    Ok(())
}

fn release_lock(state: &mut VaultState) {
    state.locked = false;
    state.lock_timestamp = None;
}

// In deposit and release
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    acquire_lock(&mut ctx.accounts.vault_state)?;
    
    // Use defer-like pattern to ensure lock is always released
    let result = (|| -> Result<()> {
        // ... deposit logic ...
        Ok(())
    })();
    
    release_lock(&mut ctx.accounts.vault_state);
    result
}

// Lock recovery (authorized)
pub fn recover_lock(ctx: Context<RecoverLock>) -> Result<()> {
    // Only authority can recover
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.vault_state.pool_authority,
        VaultError::UnauthorizedCaller
    );
    
    let state = &mut ctx.accounts.vault_state;
    if state.locked {
        msg!("Recovering stuck lock");
        release_lock(state);
    }
    
    Ok(())
}
```

