# Hook Whitelist Unbounded Growth

## Severity: MEDIUM

## Description

The `HookWhitelist` has a `MAX_PROGRAMS` constant (100), but there's no validation when adding programs to ensure the limit isn't exceeded. If the limit is exceeded, the account could grow beyond expected size or operations could fail.

## Vulnerability Details

### Current Implementation

```5086:5093:programs/pool/src/lib.rs
impl HookWhitelist {
    pub const MAX_PROGRAMS: usize = 100;
    pub const SPACE: usize = 8 + 32 + 4 + (32 * Self::MAX_PROGRAMS) + 1 + 7;
    
    pub fn is_allowed(&self, hook_program: &Pubkey) -> bool {
        self.allowed_programs.contains(hook_program)
    }
}
```

The `allowed_programs` is a `Vec<Pubkey>`, which can grow beyond `MAX_PROGRAMS` if not validated.

### Potential Vulnerabilities

1. **Account Size Exceeded**: If more than 100 programs are added, the account could exceed its allocated space, causing:
   - Reallocation failures
   - Account size limit exceeded
   - Transaction failures

2. **No Validation on Add**: There's no instruction to add programs to whitelist visible in the search results, but if one exists, it should validate the limit.

3. **DoS via Account Growth**: An attacker who can add programs could cause the account to grow, consuming more rent and potentially causing issues.

## Exploitation Scenario

```rust
// Scenario: Exceeding MAX_PROGRAMS
// 1. Attacker or bug adds more than 100 programs to whitelist
// 2. allowed_programs Vec grows beyond 100
// 3. Account size exceeds SPACE calculation
// 4. Account reallocation fails or exceeds Solana limits
// 5. Operations fail
```

## Code References

- MAX_PROGRAMS: Line 5087
- SPACE calculation: Line 5088
- allowed_programs: Vec<Pubkey> in HookWhitelist struct

## Mitigation

1. **Add validation when adding programs**:
```rust
pub fn add_program(&mut self, program: Pubkey) -> Result<()> {
    require!(
        self.allowed_programs.len() < Self::MAX_PROGRAMS,
        PoolError::HookWhitelistFull
    );
    require!(
        !self.allowed_programs.contains(&program),
        PoolError::HookProgramAlreadyWhitelisted
    );
    self.allowed_programs.push(program);
    Ok(())
}
```

2. **Add error types**:
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("Hook whitelist is full")]
    HookWhitelistFull,
    #[msg("Hook program already whitelisted")]
    HookProgramAlreadyWhitelisted,
}
```

3. **Validate in account constraints**:
```rust
#[derive(Accounts)]
pub struct AddHookProgram<'info> {
    #[account(
        mut,
        seeds = [seeds::HOOK_WHITELIST, pool_state.key().as_ref()],
        bump = hook_whitelist.bump,
        constraint = hook_whitelist.allowed_programs.len() < HookWhitelist::MAX_PROGRAMS @ PoolError::HookWhitelistFull,
    )]
    pub hook_whitelist: Account<'info, HookWhitelist>,
    // ... other accounts ...
}
```

4. **Add integrity check**:
```rust
impl HookWhitelist {
    pub fn validate_integrity(&self) -> Result<()> {
        require!(
            self.allowed_programs.len() <= Self::MAX_PROGRAMS,
            PoolError::HookWhitelistCorrupt
        );
        Ok(())
    }
}
```

## Additional Considerations

- The SPACE calculation assumes MAX_PROGRAMS, so exceeding it will cause issues
- Consider whether MAX_PROGRAMS (100) is sufficient
- Add monitoring for whitelist size

