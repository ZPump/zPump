# No Protocol Fees Withdrawal Mechanism

## Severity: MEDIUM

## Description

The pool accumulates `protocol_fees` (line 1546-1549) but there is no mechanism to withdraw or collect these fees. The fees accumulate indefinitely and are permanently locked in the pool state, representing lost revenue for the protocol and potential accounting issues.

## Vulnerability Details

### Current Implementation

```rust
pool_state.protocol_fees = pool_state
    .protocol_fees
    .checked_add(u128::from(fee))
    .ok_or(PoolError::AmountOverflow)?;
```

The fees:
- Accumulate in `pool_state.protocol_fees` (u128)
- Are included in supply invariant checks (line 1875)
- Have NO withdrawal mechanism
- Are permanently locked

### Potential Vulnerabilities

1. **Lost Revenue**: Protocol fees accumulate but cannot be collected, representing permanent loss of protocol revenue.

2. **Accounting Issues**: Fees are tracked but never withdrawn, creating accounting discrepancies and making it unclear how fees relate to actual vault balance.

3. **Invariant Confusion**: Fees are included in supply invariant (`vault_balance == twin_supply + note_ledger.live_value + protocol_fees`), but since they're never withdrawn, they're effectively part of the vault balance, making the accounting confusing.

4. **Overflow Risk**: If fees accumulate indefinitely, `protocol_fees` (u128) could theoretically overflow, though this is highly unlikely in practice.

5. **Governance Limitation**: Without a withdrawal mechanism, protocol governance cannot collect fees, limiting protocol sustainability.

## Exploitation Scenario

```rust
// Scenario 1: Lost revenue
// 1. Pool accumulates fees over time
// 2. protocol_fees grows to significant amount
// 3. No way to withdraw fees
// 4. Protocol loses revenue
// 5. Protocol sustainability is compromised

// Scenario 2: Accounting confusion
// 1. Fees accumulate in protocol_fees
// 2. Fees are included in supply invariant
// 3. But fees are never actually withdrawn from vault
// 4. Accounting becomes confusing
// 5. Invariant checks become harder to understand

// Scenario 3: Overflow (theoretical)
// 1. Pool operates for very long time
// 2. Fees accumulate continuously
// 3. protocol_fees approaches u128::MAX
// 4. Overflow could occur (though highly unlikely)
```

## Code References

- Fee accumulation: Lines 1546-1549
- Supply invariant: Line 1875
- No withdrawal function exists
- `protocol_fees` field: Line 2932

## Mitigation

1. **Add Withdrawal Function**: Create a function to withdraw protocol fees:

```rust
pub fn withdraw_protocol_fees(
    ctx: Context<WithdrawProtocolFees>,
    amount: u64,
) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    
    // Validate authority
    require_keys_eq!(
        ctx.accounts.authority.key(),
        pool_state.authority,
        PoolError::Unauthorized
    );
    
    // Validate amount
    require!(amount > 0, PoolError::InvalidAmount);
    require!(
        u128::from(amount) <= pool_state.protocol_fees,
        PoolError::InsufficientFees
    );
    
    // Update protocol_fees
    pool_state.protocol_fees = pool_state
        .protocol_fees
        .checked_sub(u128::from(amount))
        .ok_or(PoolError::AmountOverflow)?;
    
    // CPI to vault to release tokens
    let signer_seeds: [&[u8]; 3] = [
        seeds::POOL,
        pool_state.origin_mint.as_ref(),
        &[pool_state.bump],
    ];
    let cpi_accounts = ptf_vault::cpi::accounts::Release {
        vault_state: ctx.accounts.vault_state.to_account_info(),
        vault_token_account: ctx.accounts.vault_token_account.to_account_info(),
        destination_token_account: ctx.accounts.destination_token_account.to_account_info(),
        pool_authority: ctx.accounts.pool_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.vault_program.to_account_info(),
        cpi_accounts,
        &[&signer_seeds],
    );
    ptf_vault::cpi::release(cpi_ctx, amount)?;
    
    emit!(ProtocolFeesWithdrawn {
        origin_mint: pool_state.origin_mint,
        amount,
        remaining: pool_state.protocol_fees,
    });
    
    Ok(())
}
```

2. **Add Account Structure**: Create account structure for withdrawal:

```rust
#[derive(Accounts)]
pub struct WithdrawProtocolFees<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump,
        has_one = authority
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(mut)]
    pub vault_state: Account<'info, ptf_vault::VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    pub vault_program: Program<'info, PtfVault>,
    pub token_program: Interface<'info, TokenInterface>,
}
```

3. **Add Error Types**: Add error variants:

```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("insufficient protocol fees available")]
    InsufficientFees,
}
```

4. **Update Invariant**: Consider whether fees should be included in supply invariant if they're withdrawable, or if they should be tracked separately.

5. **Add Limits**: Consider adding withdrawal limits or rate limiting to prevent abuse.

6. **Governance Integration**: If fees are for protocol governance, integrate with governance mechanism for withdrawal authorization.

