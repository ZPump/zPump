# Mitigation: Hook Whitelist Can Be DoS'd

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 12

## Problem Description

Hook whitelist has maximum of 100 programs with no removal mechanism. Once full, no new hooks can be added.

## Security Impact

1. **Permanent DoS:** Once whitelist fills, system frozen
2. **No Recovery:** Cannot remove malicious or unused hooks
3. **Operational Risk:** Legitimate hooks cannot be added

## Mitigation

Add removal function:

```rust
pub fn remove_hook_from_whitelist(
    ctx: Context<ManageHookWhitelist>,
    hook_program: Pubkey,
) -> Result<()> {
    let whitelist = &mut ctx.accounts.hook_whitelist;
    
    // Find and remove
    if let Some(pos) = whitelist.allowed_programs.iter().position(|&p| p == hook_program) {
        whitelist.allowed_programs.remove(pos);
        emit!(HookRemovedFromWhitelist {
            hook_program,
            removed_by: ctx.accounts.authority.key(),
        });
    }
    
    Ok(())
}
```

## Additional

Consider increasing MAX_PROGRAMS or making it dynamic.

## References

- Issue location: `programs/pool/src/lib.rs:3561-3575`

