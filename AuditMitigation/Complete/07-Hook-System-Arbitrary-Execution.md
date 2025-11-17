# Fix 07: Hook System Allows Arbitrary Program Execution (HIGH)

## Problem Description

### Location
- **Contract**: `ptf_pool`
- **File**: `programs/pool/src/lib.rs`
- **Lines**: 659-720 (shield_finalize_ledger), hook configuration

### Current Behavior
The hook system allows calling arbitrary programs after shield/unshield operations. While there are some account validation checks (`HookAccountMode::Strict`), the system is complex and could allow malicious hooks to drain funds or manipulate state. Hooks execute with pool authority, giving them significant power.

### Code Snippet (Current - Risky)

```rust
if hook_enabled {
    let (required_accounts, hook_mode, target_program, post_shield_enabled) = {
        let hook_config = ctx.accounts.hook_config.load()?;
        (
            hook_config.required_keys().collect::<Vec<_>>(),
            hook_config.mode,
            hook_config.post_shield_program_id,
            hook_config.post_shield_enabled,
        )
    };
    if post_shield_enabled && target_program != Pubkey::default() {
        // ⚠️ Executes arbitrary program with pool authority
        invoke_signed(&hook_ix, &hook_accounts, &signer_seeds)?;
    }
}
```

### Why This Is High Severity

1. **Arbitrary Program Execution**: Any program can be configured as a hook, including malicious ones. While `HookAccountMode::Strict` helps, it may not catch all attack vectors.

2. **Pool Authority Power**: Hooks execute with pool authority (via `invoke_signed`), giving them the ability to:
   - Call vault `release` to drain funds
   - Manipulate pool state
   - Bypass security checks
   - Perform unauthorized operations

3. **Complex Attack Surface**: The hook system has many moving parts:
   - Account validation modes
   - Required accounts lists
   - Multiple hook types (post-shield, post-unshield)
   - Complex account passing logic

4. **No Whitelist**: There's no whitelist of allowed hook programs, so any program can be used.

5. **Configuration Risk**: If hook configuration is compromised or misconfigured, malicious hooks can be enabled.

### Attack Scenario

1. Attacker deploys malicious hook program that:
   - Accepts pool authority signature
   - Calls vault `release` to send funds to attacker
   - Or manipulates pool state
2. Attacker (or compromised authority) configures this as a hook
3. User performs shield/unshield operation
4. Hook executes with pool authority
5. Malicious hook drains funds or manipulates state

## Solution

### Fix Strategy
Implement multiple layers of security:
1. **Whitelist**: Only allow pre-approved hook programs
2. **Audit Requirement**: Require hooks to be audited before enabling
3. **Timelock**: Add timelock for hook configuration changes
4. **Limited Permissions**: Restrict what hooks can do
5. **Monitoring**: Enhanced logging and monitoring

### Implementation

#### Step 1: Add Hook Whitelist Account

**Location**: `programs/pool/src/lib.rs` - Add new account structure

**Add**:
```rust
#[account]
pub struct HookWhitelist {
    pub authority: Pubkey,
    pub allowed_programs: Vec<Pubkey>,
    pub bump: u8,
}

impl HookWhitelist {
    pub const MAX_PROGRAMS: usize = 100;
    pub const SPACE: usize = 8 + 32 + 4 + (32 * Self::MAX_PROGRAMS) + 1 + 7;
}

pub fn is_hook_allowed(hook_program: &Pubkey, whitelist: &HookWhitelist) -> bool {
    whitelist.allowed_programs.contains(hook_program)
}
```

#### Step 2: Add Whitelist Management Functions

**Location**: `programs/pool/src/lib.rs` - Add new functions

**Add**:
```rust
pub fn initialize_hook_whitelist(
    ctx: Context<InitializeHookWhitelist>,
) -> Result<()> {
    let whitelist = &mut ctx.accounts.hook_whitelist;
    whitelist.authority = ctx.accounts.authority.key();
    whitelist.allowed_programs = Vec::new();
    whitelist.bump = ctx.bumps.hook_whitelist;
    Ok(())
}

pub fn add_hook_to_whitelist(
    ctx: Context<ManageHookWhitelist>,
    hook_program: Pubkey,
) -> Result<()> {
    let whitelist = &mut ctx.accounts.hook_whitelist;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        whitelist.authority,
        PoolError::Unauthorized
    );
    require!(
        !whitelist.allowed_programs.contains(&hook_program),
        PoolError::HookAlreadyWhitelisted
    );
    require!(
        whitelist.allowed_programs.len() < HookWhitelist::MAX_PROGRAMS,
        PoolError::WhitelistFull
    );
    whitelist.allowed_programs.push(hook_program);
    emit!(HookAddedToWhitelist {
        hook_program,
        added_by: ctx.accounts.authority.key(),
    });
    Ok(())
}

pub fn remove_hook_from_whitelist(
    ctx: Context<ManageHookWhitelist>,
    hook_program: Pubkey,
) -> Result<()> {
    let whitelist = &mut ctx.accounts.hook_whitelist;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        whitelist.authority,
        PoolError::Unauthorized
    );
    let index = whitelist.allowed_programs
        .iter()
        .position(|&p| p == hook_program)
        .ok_or(PoolError::HookNotWhitelisted)?;
    whitelist.allowed_programs.remove(index);
    emit!(HookRemovedFromWhitelist {
        hook_program,
        removed_by: ctx.accounts.authority.key(),
    });
    Ok(())
}
```

#### Step 3: Update `configure_hooks` to Check Whitelist

**Location**: `programs/pool/src/lib.rs` around line 301

**Change**:
```rust
pub fn configure_hooks(ctx: Context<ConfigureHooks>, args: HookConfigArgs) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    require!(
        pool_state
            .features
            .contains(FeatureFlags::from(FEATURE_HOOKS_ENABLED)),
        PoolError::HooksDisabled,
    );

    // CRITICAL FIX: Check whitelist for hook programs
    if args.post_shield_enabled && args.post_shield_program != Pubkey::default() {
        let whitelist = ctx.accounts.hook_whitelist.load()?;
        require!(
            is_hook_allowed(&args.post_shield_program, &whitelist),
            PoolError::HookNotWhitelisted
        );
    }
    
    if args.post_unshield_enabled && args.post_unshield_program != Pubkey::default() {
        let whitelist = ctx.accounts.hook_whitelist.load()?;
        require!(
            is_hook_allowed(&args.post_unshield_program, &whitelist),
            PoolError::HookNotWhitelisted
        );
    }

    let mut hook_config = ctx.accounts.hook_config.load_mut()?;
    // ... rest of function
}
```

#### Step 4: Add Timelock for Hook Configuration

**Location**: Create pending hook configuration account

**Add**:
```rust
#[account]
pub struct PendingHookConfig {
    pub pool: Pubkey,
    pub new_config: HookConfigArgs,
    pub proposed_at: i64,
    pub execute_after: i64,
    pub executed: bool,
    pub bump: u8,
}

pub fn propose_hook_config(
    ctx: Context<ProposeHookConfig>,
    args: HookConfigArgs,
) -> Result<()> {
    // Validate whitelist
    // Create pending config with timelock
    // ...
}

pub fn execute_hook_config(
    ctx: Context<ExecuteHookConfig>,
) -> Result<()> {
    // Verify timelock expired
    // Apply hook config
    // ...
}
```

#### Step 5: Add Account Contexts

**Location**: `programs/pool/src/lib.rs` - Add account structs

**Add**:
```rust
#[derive(Accounts)]
pub struct ConfigureHooks<'info> {
    #[account(mut, has_one = authority)]
    pub pool_state: AccountLoader<'info, PoolState>,
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"hook-whitelist", pool_state.load()?.origin_mint.as_ref()],
        bump = hook_whitelist.bump
    )]
    pub hook_whitelist: AccountLoader<'info, HookWhitelist>,
    #[account(mut)]
    pub hook_config: AccountLoader<'info, HookConfig>,
}

#[derive(Accounts)]
pub struct InitializeHookWhitelist<'info> {
    #[account(
        init,
        payer = authority,
        seeds = [b"hook-whitelist", pool_state.load()?.origin_mint.as_ref()],
        bump,
        space = HookWhitelist::SPACE,
    )]
    pub hook_whitelist: AccountLoader<'info, HookWhitelist>,
    #[account(mut, has_one = authority)]
    pub pool_state: AccountLoader<'info, PoolState>,
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

#### Step 6: Update Hook Execution to Verify Whitelist

**Location**: `programs/pool/src/lib.rs` in hook execution code

**Add**:
```rust
if hook_enabled {
    let hook_config = ctx.accounts.hook_config.load()?;
    
    // CRITICAL FIX: Verify hook is still whitelisted at execution time
    if post_shield_enabled && target_program != Pubkey::default() {
        let whitelist = ctx.accounts.hook_whitelist.load()?;
        require!(
            is_hook_allowed(&target_program, &whitelist),
            PoolError::HookNotWhitelisted
        );
        // ... execute hook
    }
}
```

#### Step 7: Add Error Types

**Location**: `programs/pool/src/lib.rs` in error enum

**Add**:
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("E_HOOK_NOT_WHITELISTED")]
    HookNotWhitelisted,
    #[msg("E_HOOK_ALREADY_WHITELISTED")]
    HookAlreadyWhitelisted,
    #[msg("E_WHITELIST_FULL")]
    WhitelistFull,
    // ... other errors ...
}
```

#### Step 8: Add Events

**Location**: `programs/pool/src/lib.rs` - Add events

**Add**:
```rust
#[event]
pub struct HookAddedToWhitelist {
    pub hook_program: Pubkey,
    pub added_by: Pubkey,
}

#[event]
pub struct HookRemovedFromWhitelist {
    pub hook_program: Pubkey,
    pub removed_by: Pubkey,
}
```

### Testing

#### Test Case 1: Whitelist Enforcement
```rust
#[test]
fn test_hook_must_be_whitelisted() {
    // Try to configure non-whitelisted hook
    // Expected: Should fail with HookNotWhitelisted
}
```

#### Test Case 2: Whitelist Management
```rust
#[test]
fn test_whitelist_management() {
    // Add hook to whitelist
    // Configure hook - should succeed
    // Remove from whitelist
    // Try to configure - should fail
}
```

#### Test Case 3: Execution-Time Verification
```rust
#[test]
fn test_hook_verified_at_execution() {
    // Configure whitelisted hook
    // Remove from whitelist
    // Try to execute - should fail
}
```

### Verification Checklist

- [ ] HookWhitelist account added
- [ ] Whitelist management functions added
- [ ] `configure_hooks` checks whitelist
- [ ] Hook execution verifies whitelist
- [ ] Timelock for config changes (optional but recommended)
- [ ] Error types added
- [ ] Events added
- [ ] Tests written and passing
- [ ] Code review completed

### Additional Considerations

1. **Initial Whitelist**: Decide which hooks to whitelist initially (if any)

2. **Audit Process**: Establish process for auditing hooks before whitelisting

3. **Removal Impact**: When removing a hook from whitelist, existing configurations may break

4. **Timelock Duration**: If implementing timelock, choose appropriate duration (e.g., 24-48 hours)

5. **Monitoring**: Monitor hook executions for suspicious activity

### Impact Assessment

**Before Fix**: 
- Security: HIGH vulnerability
- Risk: Malicious hooks can drain funds

**After Fix**:
- Security: Whitelist provides protection
- Risk: Low (with proper whitelist management)
- Breaking Change: Yes - requires whitelist setup

### Rollout Plan

1. Deploy whitelist system
2. Audit and whitelist any existing hooks
3. Update `configure_hooks` to require whitelist
4. Deploy to testnet
5. Test with whitelisted hooks
6. Deploy to mainnet
7. Monitor hook executions

---

**Priority**: HIGH - Fix before production
**Estimated Effort**: High (implement whitelist system)
**Risk of Fix**: Medium (breaking change, requires migration)

