# Pool Reinitialization Risk

## Severity: HIGH

## Description

The `initialize_pool` function uses `load_init()` which allows the pool to be reinitialized if the account data is corrupted or reset. There's no check to prevent reinitialization of an already-initialized pool, which could allow an attacker to reset critical state like `protocol_fees`, `current_root`, or `roots_len`, potentially causing loss of funds or state corruption.

## Vulnerability Details

### Current Implementation

```rust
let mut pool_state = ctx.accounts.pool_state.load_init()?;
```

The `load_init()` method:
- Initializes the account if it doesn't exist
- Reinitializes if the account exists but has wrong discriminator
- Does NOT check if pool is already initialized
- Overwrites all state fields

### Potential Vulnerabilities

1. **State Reset**: An attacker could reinitialize a pool, resetting `protocol_fees`, `current_root`, `roots_len`, and other critical state.

2. **Fund Loss**: If `protocol_fees` is reset, accumulated fees could be lost.

3. **Root History Loss**: If `roots_len` and `recent_roots` are reset, the pool loses track of valid roots, potentially breaking unshield operations.

4. **Authority Change**: The authority is set from `ctx.accounts.authority.key()`, so reinitialization could change the authority if a different signer is used.

5. **Configuration Reset**: Fee, features, and other configuration could be reset to different values.

## Exploitation Scenario

```rust
// Scenario 1: Protocol fees reset
// 1. Pool accumulates protocol fees over time
// 2. Attacker calls initialize_pool with same accounts
// 3. pool_state.protocol_fees = 0 (line 160)
// 4. Accumulated fees are lost
// 5. Protocol loses revenue

// Scenario 2: Root history reset
// 1. Pool has many valid roots in recent_roots
// 2. Attacker reinitializes pool
// 3. roots_len = 0, current_root = [0u8; 32] (lines 156-157)
// 4. All previous roots become invalid
// 5. Users cannot unshield using old roots
// 6. Funds become locked

// Scenario 3: Authority takeover
// 1. Attacker gains access to pool_state account (e.g., through account corruption)
// 2. Attacker calls initialize_pool with their own authority
// 3. pool_state.authority = attacker's key (line 151)
// 4. Attacker gains control of pool
// 5. Can change fees, features, etc.
```

## Code References

- Pool initialization: Lines 36-336
- `load_init()` usage: Line 143
- State reset: Lines 145-163
- No check for existing initialization

## Mitigation

1. **Check Initialization Status**: Add a check to prevent reinitialization:

```rust
pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16, features: u8) -> Result<()> {
    // ... existing validation ...
    
    // Check if pool is already initialized
    match ctx.accounts.pool_state.try_load() {
        Ok(existing_state) => {
            // Pool already initialized - reject
            require!(
                existing_state.origin_mint == Pubkey::default(),
                PoolError::PoolAlreadyInitialized
            );
        }
        Err(_) => {
            // Pool not initialized - proceed
        }
    }
    
    let mut pool_state = ctx.accounts.pool_state.load_init()?;
    // ... rest of initialization ...
}
```

2. **Use Discriminator Check**: Check if account has valid discriminator before initializing:

```rust
// Check if account has valid discriminator (already initialized)
if ctx.accounts.pool_state.to_account_info().data_len() >= 8 {
    let discriminator = &ctx.accounts.pool_state.to_account_info().try_borrow_data()?[0..8];
    if discriminator == &PoolState::discriminator() {
        return err!(PoolError::PoolAlreadyInitialized);
    }
}
```

3. **Add Error Type**: Add error variant for reinitialization:

```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("pool is already initialized")]
    PoolAlreadyInitialized,
}
```

4. **Use `init` Constraint**: Change from manual initialization to Anchor's `init` constraint which prevents reinitialization:

```rust
#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,  // Use 'init' instead of manual load_init
        seeds = [seeds::POOL, origin_mint.key().as_ref()],
        bump,
        payer = payer,
        space = PoolState::SPACE,
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    // ... other accounts ...
}
```

5. **Store Initialization Flag**: Add an `initialized` flag to `PoolState` and check it:

```rust
#[account]
pub struct PoolState {
    pub initialized: bool,
    // ... other fields ...
}

pub fn initialize_pool(...) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_init()?;
    
    // Check if already initialized
    if pool_state.initialized {
        return err!(PoolError::PoolAlreadyInitialized);
    }
    
    pool_state.initialized = true;
    // ... rest of initialization ...
}
```

6. **Require Authority Match**: If reinitialization is needed for upgrades, require the current authority:

```rust
// If pool exists, require current authority matches
if let Ok(existing_state) = ctx.accounts.pool_state.try_load() {
    require_keys_eq!(
        existing_state.authority,
        ctx.accounts.authority.key(),
        PoolError::Unauthorized
    );
}
```

