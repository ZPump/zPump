# Hook Execution Security

## Severity: HIGH

## Description

The pool program supports post-shield and post-unshield hooks that can execute arbitrary code. While there's a whitelist mechanism, hook execution introduces significant security risks if not properly implemented.

## Vulnerability Details

### Current Implementation

Hooks are executed via CPI (Cross-Program Invocation) after shield/unshield operations. There's a `hook_whitelist` that restricts which programs can be called as hooks.

### Potential Vulnerabilities

1. **Whitelist Bypass**: If the whitelist check is not properly enforced, an attacker could call arbitrary programs as hooks, potentially draining funds or manipulating state.

2. **Hook Reentrancy**: Hooks are executed via CPI, which means they could potentially call back into the pool program, creating reentrancy vulnerabilities.

3. **Hook Failure Handling**: If a hook fails, the entire transaction might fail, but the shield/unshield might have already partially completed, leaving state inconsistent.

4. **Hook DoS**: A malicious or buggy hook could consume excessive compute units, causing legitimate transactions to fail.

5. **Hook State Manipulation**: A hook could potentially manipulate accounts passed to it, affecting the pool's state if not properly validated.

6. **Whitelist Authority**: The whitelist has an authority that can add/remove programs. If this authority is compromised, malicious programs could be whitelisted.

## Exploitation Scenario

```rust
// Scenario 1: Whitelist bypass
// 1. Attacker finds a way to bypass whitelist check
// 2. Attacker sets hook to a malicious program
// 3. Malicious hook drains vault or manipulates pool state

// Scenario 2: Hook reentrancy
// 1. Hook program calls back into pool program
// 2. Reentrant call could bypass checks or manipulate state
// 3. Attacker could drain funds or create inconsistent state

// Scenario 3: Hook DoS
// 1. Attacker deploys a hook that consumes maximum compute units
// 2. All shield/unshield operations fail due to compute limit
// 3. Pool becomes unusable
```

## Code References

- Hook whitelist: Initialized in `shield` (lines 518-525)
- Hook execution: `process_shield_finalize_ledger` and similar functions
- Hook config: `HookConfig` account structure

## Mitigation

1. **Strict Whitelist Enforcement**: Ensure whitelist checks are performed before every hook execution, with no bypasses.

2. **Reentrancy Guards**: Implement reentrancy guards that prevent the pool program from being called recursively during hook execution.

3. **Hook Compute Limits**: Set a maximum compute unit budget for hook execution to prevent DoS attacks.

4. **Hook Failure Isolation**: Ensure that hook failures don't leave the pool in an inconsistent state. Consider making hooks optional or having a fallback mechanism.

5. **Whitelist Authority Timelock**: Require timelock for whitelist changes to prevent rapid addition of malicious programs.

6. **Hook Input Validation**: Strictly validate all accounts and data passed to hooks to prevent manipulation.

7. **Hook Audit Requirements**: Require security audits for programs before they can be whitelisted.

8. **Hook Monitoring**: Implement extensive logging and monitoring for hook executions to detect anomalous behavior.

## Recommended Code Changes

```rust
// Add reentrancy guard
pub struct PoolState {
    // ... existing fields ...
    pub hook_executing: bool, // Reentrancy guard
}

// In hook execution
fn execute_hook_safely(
    hook_program: &Program,
    hook_accounts: &[AccountInfo],
    compute_limit: u32,
) -> Result<()> {
    // Set compute budget for hook
    let mut compute_budget = ComputeBudgetInstruction::set_compute_unit_limit(compute_limit);
    invoke(&compute_budget, &[])?;
    
    // Execute hook with reentrancy guard
    // ... hook execution ...
}

// Whitelist check with strict validation
fn is_hook_whitelisted(
    hook_program: &Pubkey,
    whitelist: &HookWhitelist,
) -> Result<()> {
    require!(
        whitelist.allowed_programs.contains(hook_program),
        PoolError::HookNotWhitelisted
    );
    
    // Additional validation: check program is not the pool program itself
    require_keys_ne!(
        *hook_program,
        crate::ID,
        PoolError::HookReentrancyForbidden
    );
    
    Ok(())
}
```

