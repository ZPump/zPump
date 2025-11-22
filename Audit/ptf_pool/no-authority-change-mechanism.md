# No Pool Authority Change Mechanism

## Severity: HIGH

## Description

The pool authority is set during initialization (line 151) and cannot be changed afterward. If the authority key is compromised, lost, or needs to be rotated for security reasons, there is no way to update it, leaving the pool permanently vulnerable or unmanageable.

## Vulnerability Details

### Current Implementation

```rust
pool_state.authority = ctx.accounts.authority.key();
```

The authority:
- Set once during initialization (line 151)
- Used for `set_fee`, `set_features`, `configure_hooks`, and hook whitelist management
- Cannot be changed after initialization
- No update mechanism exists

### Potential Vulnerabilities

1. **Compromised Authority**: If authority key is compromised, attacker gains permanent control with no way to recover.

2. **Lost Key**: If authority key is lost, pool becomes unmanageable - fees, features, and hooks cannot be updated.

3. **Key Rotation Impossible**: Security best practices require periodic key rotation, which is impossible.

4. **Single Point of Failure**: Single authority key is a critical single point of failure.

5. **No Recovery Path**: If authority is compromised, there's no way to transfer control to a new authority.

## Exploitation Scenario

```rust
// Scenario 1: Compromised authority
// 1. Authority key is compromised (phishing, malware, etc.)
// 2. Attacker gains control of pool
// 3. Attacker changes fees to 100% (draining users)
// 4. Attacker disables features
// 5. No way to recover or change authority
// 6. Pool is permanently compromised

// Scenario 2: Lost key
// 1. Authority key is lost (hardware failure, forgotten, etc.)
// 2. Pool cannot be managed
// 3. Fees cannot be adjusted
// 4. Features cannot be updated
// 5. Hooks cannot be configured
// 6. Pool becomes unmanageable

// Scenario 3: Key rotation needed
// 1. Security audit requires key rotation
// 2. No mechanism to rotate authority
// 3. Pool remains with old key
// 4. Security compliance cannot be achieved
```

## Code References

- Authority initialization: Line 151
- Authority usage: Lines 338 (set_fee), 349 (set_features), 359 (configure_hooks), 417 (add_hook), 459 (remove_hook)
- No update function exists

## Mitigation

1. **Add Authority Change Function**: Create a function to change authority with proper authorization:

```rust
pub fn change_authority(
    ctx: Context<ChangeAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    
    // Validate current authority
    require_keys_eq!(
        ctx.accounts.current_authority.key(),
        pool_state.authority,
        PoolError::Unauthorized
    );
    
    // Validate new authority is not default
    require!(
        new_authority != Pubkey::default(),
        PoolError::InvalidAuthority
    );
    
    // Update authority
    let old_authority = pool_state.authority;
    pool_state.authority = new_authority;
    
    // Update hook whitelist authority if it exists
    // (This would require additional account handling)
    
    emit!(AuthorityChanged {
        origin_mint: pool_state.origin_mint,
        old_authority,
        new_authority,
    });
    
    Ok(())
}
```

2. **Add Account Structure**: Create account structure:

```rust
#[derive(Accounts)]
pub struct ChangeAuthority<'info> {
    pub current_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump,
        has_one = authority @ PoolError::Unauthorized
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    // Note: has_one constraint validates current_authority matches pool_state.authority
}
```

3. **Use Timelock**: Implement timelock for authority changes (similar to factory):

```rust
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_authority: Pubkey,
) -> Result<()> {
    // Queue authority change through timelock
    // Similar to factory's timelock mechanism
}
```

4. **Multi-Sig Support**: Consider multi-sig authority instead of single authority.

5. **Add Error Types**: Add error variants:

```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("invalid authority")]
    InvalidAuthority,
}
```

6. **Update Hook Whitelist**: When authority changes, update hook whitelist authority as well:

```rust
// After changing pool authority, update hook whitelist
let mut hook_whitelist = ctx.accounts.hook_whitelist.load_mut()?;
hook_whitelist.authority = new_authority;
```

7. **Documentation**: Clearly document the authority change process and requirements.

