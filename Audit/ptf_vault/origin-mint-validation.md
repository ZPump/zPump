# Origin Mint Validation During Initialization

**Severity**: MEDIUM

## Description

The `initialize_vault` function accepts an `origin_mint` as an `AccountInfo` with only a CHECK comment, but doesn't validate that it's actually a valid SPL token mint account. This could allow initialization with invalid or malicious mint accounts.

## Vulnerability Details

The `InitializeVault` struct accepts `origin_mint` as an unchecked account:

```246:261:programs/vault/src/lib.rs
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [seeds::VAULT, origin_mint.key().as_ref()],
        bump,
        space = VaultState::SPACE,
    )]
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: Anchor verifies ownership when initializing the associated token account externally.
    pub origin_mint: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

The function simply stores the mint's key without validation:

```19:26:programs/vault/src/lib.rs
pub fn initialize_vault(ctx: Context<InitializeVault>, pool_authority: Pubkey) -> Result<()> {
    let state = &mut ctx.accounts.vault_state;
    state.origin_mint = ctx.accounts.origin_mint.key();
    state.pool_authority = pool_authority;
    state.bump = ctx.bumps.vault_state;
    state.locked = false; // Initialize reentrancy guard
    Ok(())
}
```

There's no validation that:
1. `origin_mint` is actually owned by a token program (SPL Token or Token-2022)
2. `origin_mint` is a valid mint account (not just any account)
3. `origin_mint` matches the expected mint for the vault

## Exploitation Scenario

1. **Invalid Mint Initialization**: An attacker could initialize a vault with a non-mint account:
   - Attacker provides a regular account as `origin_mint`
   - Vault is initialized with invalid mint
   - Subsequent operations fail or behave unexpectedly

2. **Wrong Mint Initialization**: A developer could accidentally initialize a vault with the wrong mint:
   - Vault initialized for TokenA but with TokenB's mint
   - Causes confusion and potential security issues
   - Token accounts won't match

3. **Malicious Mint**: An attacker could use a malicious or compromised mint:
   - Mint with unusual properties (e.g., freeze authority, close authority)
   - Could lead to unexpected behavior in deposit/release operations

## Code References

```19:26:programs/vault/src/lib.rs
pub fn initialize_vault(ctx: Context<InitializeVault>, pool_authority: Pubkey) -> Result<()> {
    let state = &mut ctx.accounts.vault_state;
    state.origin_mint = ctx.accounts.origin_mint.key();
    // ... no validation of origin_mint ...
}
```

```256:257:programs/vault/src/lib.rs
/// CHECK: Anchor verifies ownership when initializing the associated token account externally.
pub origin_mint: AccountInfo<'info>,
```

## Mitigation

1. **Validate Mint Account**: Use `InterfaceAccount<Mint>` instead of `AccountInfo` to ensure it's a valid mint:
   ```rust
   pub origin_mint: InterfaceAccount<'info, Mint>,
   ```

2. **Validate Token Program**: Ensure the mint is owned by a valid token program:
   ```rust
   require_keys_eq!(
       ctx.accounts.origin_mint.owner,
       ctx.accounts.token_program.key(),
       VaultError::InvalidMint
   );
   ```

3. **Validate Mint Properties**: Optionally validate mint properties (decimals, supply, etc.) are reasonable.

## Recommended Code Changes

```rust
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [seeds::VAULT, origin_mint.key().as_ref()],
        bump,
        space = VaultState::SPACE,
    )]
    pub vault_state: Account<'info, VaultState>,
    // CRITICAL FIX: Use InterfaceAccount to validate mint
    pub origin_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_vault(ctx: Context<InitializeVault>, pool_authority: Pubkey) -> Result<()> {
    // CRITICAL FIX: Validate mint is owned by token program
    require_keys_eq!(
        ctx.accounts.origin_mint.owner,
        ctx.accounts.token_program.key(),
        VaultError::InvalidMint
    );
    
    // Optionally validate mint properties
    require!(
        ctx.accounts.origin_mint.decimals <= 18, // Reasonable limit
        VaultError::InvalidMint
    );
    
    let state = &mut ctx.accounts.vault_state;
    state.origin_mint = ctx.accounts.origin_mint.key();
    state.pool_authority = pool_authority;
    state.bump = ctx.bumps.vault_state;
    state.locked = false;
    Ok(())
}
```

## Additional Considerations

- Consider validating that the mint is not frozen (if using Token-2022).
- Consider checking that the mint has reasonable supply limits.
- Add events to log mint validation failures.
- Consider requiring the mint to be registered in the factory before vault initialization.

