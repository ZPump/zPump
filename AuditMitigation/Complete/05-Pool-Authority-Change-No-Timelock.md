# Fix 05: Pool Authority Can Be Changed Without Timelock (HIGH)

## Problem Description

### Location
- **Contract**: `ptf_vault`
- **File**: `programs/vault/src/lib.rs`
- **Lines**: 84-96

### Current Behavior
The `set_pool_authority` function allows the current pool authority to instantly change the authority to any new address without any timelock, multi-sig, or additional safeguards. This is a critical operation since the vault holds all user funds.

### Code Snippet (Current - Broken)

```rust
pub fn set_pool_authority(
    ctx: Context<SetPoolAuthority>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    let state = &mut ctx.accounts.vault_state;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.pool_authority,
        VaultError::UnauthorizedCaller
    );
    state.pool_authority = new_pool_authority;  // ⚠️ Instant change, no timelock!
    Ok(())
}
```

### Why This Is High Severity

1. **Single Point of Failure**: The vault holds all user funds. If the pool authority key is compromised, an attacker can immediately change it to their own key and gain control of all funds.

2. **No Recovery Window**: Without a timelock, there's no window for:
   - Detecting the compromise
   - Responding to the attack
   - Reversing the change
   - Alerting users

3. **No Event Emission**: The function doesn't emit an event, making it harder to detect and track authority changes off-chain.

4. **No Multi-Sig Protection**: A single compromised key can immediately compromise the entire vault.

5. **Irreversible**: Once changed, the old authority cannot reverse the change (unless they still have control, which defeats the purpose).

### Attack Scenario

1. Attacker compromises pool authority private key
2. Attacker immediately calls `set_pool_authority` with their own address
3. Change takes effect instantly
4. Attacker now controls the vault and can:
   - Release all funds to their own address
   - Drain the entire vault
   - No one can stop them in time

## Solution

### Fix Strategy
Implement a two-step timelock process:
1. **Propose**: Authority proposes a new authority (with timelock delay)
2. **Execute**: After timelock expires, anyone can execute the change

This provides:
- Time delay for detection and response
- Ability to cancel if proposed in error
- Event emissions for monitoring
- Optional multi-sig support

### Implementation

#### Step 1: Add Pending Authority Change Account

**Location**: `programs/vault/src/lib.rs` - Add new account structure

**Add**:
```rust
#[account]
pub struct PendingAuthorityChange {
    pub vault_state: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,
    pub executed: bool,
    pub canceled: bool,
    pub bump: u8,
}

impl PendingAuthorityChange {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 1 + 7;
}

const TIMELOCK_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60; // 7 days
```

#### Step 2: Replace `set_pool_authority` with Two-Step Process

**Location**: `programs/vault/src/lib.rs` around line 84

**Replace**:
```rust
// REMOVED: Direct set_pool_authority
// pub fn set_pool_authority(...) -> Result<()> { ... }

// NEW: Propose authority change
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    let state = &ctx.accounts.vault_state;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.pool_authority,
        VaultError::UnauthorizedCaller
    );
    require!(
        new_pool_authority != state.pool_authority,
        VaultError::InvalidAuthorityChange
    );
    
    let clock = Clock::get()?;
    let execute_after = clock
        .unix_timestamp
        .checked_add(TIMELOCK_DURATION_SECONDS)
        .ok_or(VaultError::TimelockOverflow)?;
    
    let pending = &mut ctx.accounts.pending_change;
    pending.vault_state = state.key();
    pending.current_authority = state.pool_authority;
    pending.new_authority = new_pool_authority;
    pending.proposed_at = clock.unix_timestamp;
    pending.execute_after = execute_after;
    pending.executed = false;
    pending.canceled = false;
    pending.bump = ctx.bumps.pending_change;
    
    emit!(AuthorityChangeProposed {
        vault_state: state.key(),
        origin_mint: state.origin_mint,
        current_authority: state.pool_authority,
        new_authority: new_pool_authority,
        proposed_at: clock.unix_timestamp,
        execute_after,
    });
    
    Ok(())
}

// NEW: Execute authority change (after timelock)
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
    require_keys_eq!(
        pending.current_authority,
        state.pool_authority,
        VaultError::AuthorityMismatch
    );
    
    let old_authority = state.pool_authority;
    state.pool_authority = pending.new_authority;
    pending.executed = true;
    
    emit!(AuthorityChangeExecuted {
        vault_state: state.key(),
        origin_mint: state.origin_mint,
        old_authority,
        new_authority: pending.new_authority,
        executed_at: clock.unix_timestamp,
        executed_by: ctx.accounts.executor.key(),
    });
    
    Ok(())
}

// NEW: Cancel proposed authority change
pub fn cancel_authority_change(
    ctx: Context<CancelAuthorityChange>,
) -> Result<()> {
    let pending = &mut ctx.accounts.pending_change;
    require!(!pending.executed, VaultError::AlreadyExecuted);
    require!(!pending.canceled, VaultError::AlreadyCanceled);
    
    let state = &ctx.accounts.vault_state;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.pool_authority,
        VaultError::UnauthorizedCaller
    );
    require_keys_eq!(
        pending.vault_state,
        state.key(),
        VaultError::VaultMismatch
    );
    
    pending.canceled = true;
    let clock = Clock::get()?;
    
    emit!(AuthorityChangeCanceled {
        vault_state: state.key(),
        origin_mint: state.origin_mint,
        canceled_at: clock.unix_timestamp,
        authority: ctx.accounts.authority.key(),
    });
    
    Ok(())
}
```

#### Step 3: Add Account Contexts

**Location**: `programs/vault/src/lib.rs` - Add after existing account structs

**Add**:
```rust
#[derive(Accounts)]
pub struct ProposeAuthorityChange<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [
            b"pending-auth",
            vault_state.key().as_ref()
        ],
        bump,
        space = PendingAuthorityChange::SPACE,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    pub system_program: Program<'info, System>,
}

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
        close = executor,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
    #[account(mut)]
    pub executor: Signer<'info>,
}

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
        close = authority,
    )]
    pub pending_change: Account<'info, PendingAuthorityChange>,
}
```

#### Step 4: Add Events

**Location**: `programs/vault/src/lib.rs` - Add after existing events

**Add**:
```rust
#[event]
pub struct AuthorityChangeProposed {
    pub vault_state: Pubkey,
    pub origin_mint: Pubkey,
    pub current_authority: Pubkey,
    pub new_authority: Pubkey,
    pub proposed_at: i64,
    pub execute_after: i64,
}

#[event]
pub struct AuthorityChangeExecuted {
    pub vault_state: Pubkey,
    pub origin_mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub executed_at: i64,
    pub executed_by: Pubkey,
}

#[event]
pub struct AuthorityChangeCanceled {
    pub vault_state: Pubkey,
    pub origin_mint: Pubkey,
    pub canceled_at: i64,
    pub authority: Pubkey,
}
```

#### Step 5: Update Error Enum

**Location**: `programs/vault/src/lib.rs` in error enum

**Add**:
```rust
#[error_code]
pub enum VaultError {
    // ... existing errors ...
    #[msg("E_TIMELOCK_OVERFLOW")]
    TimelockOverflow,
    #[msg("E_TIMELOCK_NOT_READY")]
    TimelockNotReady,
    #[msg("E_ALREADY_EXECUTED")]
    AlreadyExecuted,
    #[msg("E_CHANGE_CANCELED")]
    ChangeCanceled,
    #[msg("E_VAULT_MISMATCH")]
    VaultMismatch,
    #[msg("E_AUTHORITY_MISMATCH")]
    AuthorityMismatch,
    #[msg("E_INVALID_AUTHORITY_CHANGE")]
    InvalidAuthorityChange,
    #[msg("E_ALREADY_CANCELED")]
    AlreadyCanceled,
}
```

### Testing

#### Test Case 1: Timelock Enforced
```rust
#[test]
fn test_authority_change_timelock() {
    // Propose authority change
    // Try to execute immediately - should fail
    // Wait for timelock - should succeed
}
```

#### Test Case 2: Cancel Works
```rust
#[test]
fn test_authority_change_cancel() {
    // Propose authority change
    // Cancel it
    // Try to execute - should fail
}
```

#### Test Case 3: Only Current Authority Can Propose
```rust
#[test]
fn test_only_authority_can_propose() {
    // Try to propose with wrong authority - should fail
}
```

### Verification Checklist

- [ ] PendingAuthorityChange account added
- [ ] propose_authority_change function added
- [ ] execute_authority_change function added
- [ ] cancel_authority_change function added
- [ ] Old set_pool_authority removed
- [ ] Events added
- [ ] Error types added
- [ ] Tests written and passing
- [ ] Code review completed

### Additional Considerations

1. **Timelock Duration**: 7 days is recommended, but can be adjusted based on risk tolerance

2. **Multi-Sig Option**: Consider requiring multiple approvals for authority changes

3. **Monitoring**: Set up off-chain monitoring to alert on authority change proposals

4. **Documentation**: Document the two-step process for users

### Impact Assessment

**Before Fix**: 
- Security: HIGH vulnerability
- Risk: Immediate vault compromise if authority compromised

**After Fix**:
- Security: Timelock provides protection window
- Risk: Low (with proper timelock)
- Breaking Change: Yes - requires new workflow

---

**Priority**: HIGH - Fix before production
**Estimated Effort**: Medium (implement timelock system)
**Risk of Fix**: Low (makes code more secure)

