# Hook Account Validation Timing Issues

## Severity: MEDIUM

## Description

The hook execution validates accounts at instruction time, but the hook program could potentially manipulate account states between validation and execution, or the validation might not catch all edge cases.

## Vulnerability Details

### Current Implementation

```2215:2235:programs/pool/src/lib.rs
validate_hook_accounts(&required_accounts, hook_mode, ctx.remaining_accounts)?;

let mut metas = Vec::with_capacity(2 + ctx.remaining_accounts.len());
let mut infos = Vec::with_capacity(2 + ctx.remaining_accounts.len());

let hook_config_info = ctx.accounts.hook_config.to_account_info();
let pool_info = ctx.accounts.pool_state.to_account_info();
metas.push(AccountMeta::new_readonly(hook_config_info.key(), false));
metas.push(AccountMeta::new_readonly(pool_info.key(), false));
infos.push(hook_config_info);
infos.push(pool_info);

for account in ctx.remaining_accounts.iter() {
    let meta = if account.is_writable {
        AccountMeta::new(account.key(), account.is_signer)
    } else {
        AccountMeta::new_readonly(account.key(), account.is_signer)
    };
    metas.push(meta);
    infos.push(account.clone());
}
```

### Potential Vulnerabilities

1. **Account State Changes**: Between validation and hook execution, account states could change (though in a single transaction this is less likely).

2. **Account Ordering**: The hook might expect accounts in a specific order, but the validation might not enforce this.

3. **Missing Account Validation**: The validation checks for required accounts, but might not validate all properties (e.g., account ownership, account type).

4. **Hook Program Validation**: While the hook is whitelisted, there's no validation that the hook program hasn't been upgraded to malicious code.

## Exploitation Scenario

```rust
// Scenario: Malicious hook program upgrade
// 1. Hook program is whitelisted
// 2. Hook program is upgraded to malicious version
// 3. Pool still calls hook (whitelist check passes)
// 4. Malicious hook executes
// 5. Security is compromised

// Scenario: Account manipulation
// 1. Hook expects specific account state
// 2. Account state changes between validation and execution
// 3. Hook executes with unexpected state
// 4. Unexpected behavior or exploit
```

## Code References

- Hook account validation: Line 2215
- Hook execution: Lines 2237-2244
- Hook whitelist check: Lines 2210-2213

## Mitigation

1. **Validate hook program hasn't changed**:
```rust
// CRITICAL FIX: Validate hook program executable hash or version
// This prevents calling upgraded malicious programs
// Note: Solana doesn't provide easy way to check program hash, but we can check executable flag
require!(
    target_program_account.executable,
    PoolError::HookProgramInvalid
);
// Additional validation: Check program owner is BPF loader
require_keys_eq!(
    *target_program_account.owner,
    anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    PoolError::HookProgramInvalid
);
```

2. **Re-validate accounts right before execution**:
```rust
// Re-validate accounts immediately before hook execution
// This ensures account states haven't changed
validate_hook_accounts(&required_accounts, hook_mode, &infos[2..])?;
```

3. **Add account state validation**:
```rust
// Validate account properties (ownership, type, etc.)
// Not just presence, but also correctness
for account in ctx.remaining_accounts.iter() {
    // Validate account is owned by expected program
    // Validate account type matches expected
    // Validate account data structure
}
```

4. **Add hook execution timeout**:
```rust
// Limit hook execution time to prevent DoS
// This is handled by Solana's compute budget, but document it
```

## Additional Considerations

- Hook whitelisting is good, but program upgrades are a risk
- Consider requiring hook programs to be immutable (non-upgradeable)
- Add monitoring for hook execution failures
- Document hook security requirements

