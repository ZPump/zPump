# Token Account Validation

**Severity**: MEDIUM

## Description

The vault program doesn't fully validate that token accounts belong to the correct owners. While Anchor's `InterfaceAccount` provides some validation, there are potential edge cases where invalid accounts could be used, leading to security vulnerabilities.

## Vulnerability Details

### Deposit Function

The `deposit` function uses `InterfaceAccount` for token accounts:

```264:275:programs/vault/src/lib.rs
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub origin_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub depositor_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}
```

The function validates that `vault_token_account.mint == vault_state.origin_mint`, but doesn't validate:
1. That `vault_token_account.owner` is the vault PDA
2. That `depositor_token_account.owner` is the depositor
3. That `depositor_token_account.mint` matches `origin_mint`

### Release Function

The `release` function also uses `InterfaceAccount`:

```277:293:programs/vault/src/lib.rs
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Pool authority must be provided by the caller program.
    #[account(
        signer,
        constraint = pool_authority.key() == vault_state.pool_authority @ VaultError::UnauthorizedCaller,
        constraint = pool_authority.owner == &PTF_POOL_PROGRAM_ID @ VaultError::UnauthorizedCaller,
    )]
    pub pool_authority: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
```

The function doesn't validate:
1. That `vault_token_account.owner` is the vault PDA
2. That `destination_token_account.mint` matches `origin_mint`
3. That `destination_token_account` is not a frozen account (if using Token-2022)

## Exploitation Scenario

1. **Wrong Vault Token Account**:
   - Attacker provides a token account owned by someone else as `vault_token_account`
   - Deposit transfers tokens to wrong account
   - Tokens are lost or stolen

2. **Wrong Depositor Token Account**:
   - Attacker provides someone else's token account as `depositor_token_account`
   - Deposit transfers from wrong account
   - Attacker steals tokens from victim

3. **Wrong Destination Account**:
   - Attacker provides wrong mint token account as destination
   - Release fails or causes confusion
   - Tokens could be lost if transfer partially succeeds

4. **Frozen Account Exploitation**:
   - If using Token-2022, destination account could be frozen
   - Release transfers to frozen account
   - Tokens become inaccessible

## Code References

```28:65:programs/vault/src/lib.rs
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    // ... validates mint matches ...
    require_keys_eq!(
        ctx.accounts.vault_token_account.mint,
        vault_state.origin_mint,
        VaultError::InvalidMint,
    );
    // ... no validation of account ownership ...
}
```

```67:121:programs/vault/src/lib.rs
pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    // ... no validation of destination account mint ...
    // ... no validation of vault token account owner ...
}
```

## Mitigation

1. **Validate Vault Token Account Owner**: Ensure `vault_token_account.owner` is the vault PDA:
   ```rust
   let (expected_vault_pda, _) = Pubkey::find_program_address(
       &[seeds::VAULT, vault_state.origin_mint.as_ref()],
       &crate::ID,
   );
   require_keys_eq!(
       ctx.accounts.vault_token_account.owner,
       expected_vault_pda,
       VaultError::InvalidVaultAccount
   );
   ```

2. **Validate Depositor Token Account**: Ensure `depositor_token_account.owner` is the depositor:
   ```rust
   require_keys_eq!(
       ctx.accounts.depositor_token_account.owner,
       ctx.accounts.depositor.key(),
       VaultError::InvalidDepositorAccount
   );
   require_keys_eq!(
       ctx.accounts.depositor_token_account.mint,
       vault_state.origin_mint,
       VaultError::InvalidMint
   );
   ```

3. **Validate Destination Account**: Ensure `destination_token_account.mint` matches origin_mint:
   ```rust
   require_keys_eq!(
       ctx.accounts.destination_token_account.mint,
       vault_state.origin_mint,
       VaultError::InvalidMint
   );
   ```

4. **Check Frozen Status**: If using Token-2022, check that destination account is not frozen.

## Recommended Code Changes

```rust
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidDepositAmount);

    let vault_state = &mut ctx.accounts.vault_state;
    
    // REENTRANCY GUARD
    require!(!vault_state.locked, VaultError::ReentrancyDetected);
    vault_state.locked = true;
    
    // Validate vault token account owner
    let (expected_vault_pda, _) = Pubkey::find_program_address(
        &[seeds::VAULT, vault_state.origin_mint.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        ctx.accounts.vault_token_account.owner,
        expected_vault_pda,
        VaultError::InvalidVaultAccount
    );
    
    // Validate mint matches
    require_keys_eq!(
        ctx.accounts.vault_token_account.mint,
        vault_state.origin_mint,
        VaultError::InvalidMint,
    );
    
    // Validate depositor token account
    require_keys_eq!(
        ctx.accounts.depositor_token_account.owner,
        ctx.accounts.depositor.key(),
        VaultError::InvalidDepositorAccount
    );
    require_keys_eq!(
        ctx.accounts.depositor_token_account.mint,
        vault_state.origin_mint,
        VaultError::InvalidMint
    );
    
    // ... rest of deposit logic ...
}

pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidReleaseAmount);
    
    // Cache values before mutable borrow
    let origin_mint = ctx.accounts.vault_state.origin_mint;
    let pool_authority = ctx.accounts.vault_state.pool_authority;
    let bump = ctx.accounts.vault_state.bump;
    
    let vault_state = &mut ctx.accounts.vault_state;
    
    // REENTRANCY GUARD
    require!(!vault_state.locked, VaultError::ReentrancyDetected);
    vault_state.locked = true;
    
    validate_pool_authority(&ctx.accounts.pool_authority, &pool_authority)?;
    
    // Validate vault token account owner
    let (expected_vault_pda, _) = Pubkey::find_program_address(
        &[seeds::VAULT, origin_mint.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        ctx.accounts.vault_token_account.owner,
        expected_vault_pda,
        VaultError::InvalidVaultAccount
    );
    
    // Validate balance
    require!(
        ctx.accounts.vault_token_account.amount >= amount,
        VaultError::InsufficientBalance
    );
    
    // Validate destination account mint
    require_keys_eq!(
        ctx.accounts.destination_token_account.mint,
        origin_mint,
        VaultError::InvalidMint
    );
    
    // ... rest of release logic ...
}
```

## Additional Considerations

- Consider using Anchor constraints in the account structs for compile-time validation.
- Add checks for Token-2022 extensions (freeze, close authority, etc.).
- Consider validating that accounts are not closed.
- Add events to log account validation failures.


