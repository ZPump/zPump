# Hook Invocation Failure Handling

## Severity: MEDIUM

## Description

Hook programs are invoked using `invoke_signed` (lines 1700, 3759), but if hook invocation fails, the entire transaction fails. However, state changes (nullifiers, roots, ledger) may have already been committed before hook invocation, creating potential inconsistencies or requiring users to retry operations.

## Vulnerability Details

### Current Implementation

```rust
// In process_unshield (line 1700)
invoke_signed(&ix, &infos, &[&signer_seeds])?;

// In process_shield_finalize_ledger (line 3759)
invoke_signed(&ix, &infos, &[&signer_seeds])?;
```

The hook invocation:
- Happens after state updates (nullifiers, roots, ledger)
- Uses `?` operator - if hook fails, entire transaction fails
- No partial success handling
- No retry mechanism

### Potential Vulnerabilities

1. **Transaction Failure After State Changes**: If hook fails after state is updated, transaction fails, but state changes are rolled back. However, this creates a poor user experience.

2. **Malicious Hook DoS**: A malicious hook program could intentionally fail, causing legitimate operations to fail.

3. **Hook Program Bugs**: If hook program has bugs and fails, it blocks legitimate operations.

4. **No Error Context**: Hook failures don't provide context about what failed, making debugging difficult.

5. **State Inconsistency Risk**: If hook fails partway through, state might be partially updated.

## Exploitation Scenario

```rust
// Scenario 1: Malicious hook DoS
// 1. Attacker adds malicious hook to whitelist
// 2. Hook is configured for post_unshield
// 3. Legitimate users try to unshield
// 4. Hook intentionally fails
// 5. All unshield operations fail
// 6. System becomes unusable

// Scenario 2: Hook program bug
// 1. Legitimate hook program has bug
// 2. Hook fails during execution
// 3. All operations using hook fail
// 4. Users cannot complete operations
// 5. System is blocked

// Scenario 3: State inconsistency
// 1. Hook is invoked after state updates
// 2. Hook fails partway through
// 3. Transaction fails and rolls back
// 4. But some state might be partially updated
// 5. System becomes inconsistent
```

## Code References

- Hook invocation: Lines 1700, 3759
- Hook invocation in unshield: Lines 1646-1700
- Hook invocation in shield: Lines 3706-3760
- No error handling beyond `?` operator

## Mitigation

1. **Validate Hook Before State Changes**: If possible, validate hook can execute before committing state:

```rust
// Before updating state, validate hook can execute
if hook_enabled {
    // Pre-validate hook accounts and state
    validate_hook_preconditions(...)?;
}

// Then update state
pool_state.push_root(new_root);
note_ledger.record_unshield(...)?;

// Then invoke hook
if hook_enabled {
    invoke_signed(&ix, &infos, &[&signer_seeds])?;
}
```

2. **Make Hooks Optional**: Allow operations to proceed even if hooks fail (with proper logging):

```rust
if hook_enabled {
    match invoke_signed(&ix, &infos, &[&signer_seeds]) {
        Ok(_) => {
            emit!(HookExecuted { success: true });
        }
        Err(e) => {
            // Log error but don't fail transaction
            emit!(HookExecuted { success: false, error: e.to_string() });
            // Optionally: still fail transaction for critical hooks
            // return err!(PoolError::HookExecutionFailed);
        }
    }
}
```

3. **Add Hook Failure Error Type**: Add specific error for hook failures:

```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("hook execution failed")]
    HookExecutionFailed,
}
```

4. **Validate Hook Programs**: Before adding to whitelist, validate hook programs are legitimate and well-tested.

5. **Add Hook Timeout**: Implement timeout for hook execution to prevent hanging.

6. **Separate Critical and Non-Critical Hooks**: Distinguish between hooks that must succeed vs. optional hooks.

7. **Better Error Messages**: Provide detailed error messages when hooks fail to aid debugging.

8. **Hook Testing Requirements**: Require hook programs to be tested before whitelisting.

Note: The current implementation correctly fails the transaction if hooks fail, which is safer than allowing partial state updates. However, this creates a DoS vector if hooks are malicious or buggy.

