# PTF Vault Program Audit

## Critical Findings

1. **`release` lacks any caller authentication**  
   The vault transfers SPL tokens whenever `release` is invoked, only checking that the provided `pool_authority` pubkey matches the stored one:

```49:82:programs/vault/src/lib.rs
    pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidReleaseAmount);
        let vault_state = &ctx.accounts.vault_state;
        require_keys_eq!(
            ctx.accounts.pool_authority.key(),
            vault_state.pool_authority,
            VaultError::UnauthorizedCaller,
        );

        let seeds = &[
            seeds::VAULT,
            vault_state.origin_mint.as_ref(),
            &[vault_state.bump],
        ];
        let signer = &[&seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token_interface::transfer(cpi_ctx, amount)?;
```
   There is **no requirement** that `pool_authority` be a signer or that the call originates from `ptf_pool`. Anyone can provide the public `pool_state` account, pass their own destination token account, and drain every vault. **Recommendation:** require `pool_authority.is_signer` (the pool CPI already signs the PDA via seeds), and optionally assert `pool_authority.owner == ptf_pool::ID` to ensure only the pool program can invoke this path.

## Medium Findings

1. **`set_pool_authority` is unreachable**  
   The instruction demands `authority` signs with the value stored in `vault_state.pool_authority`:

```85:96:programs/vault/src/lib.rs
        require_keys_eq!(
            ctx.accounts.authority.key(),
            state.pool_authority,
            VaultError::UnauthorizedCaller
        );
```
   Because `pool_authority` is a PDA controlled by `ptf_pool`, there is no private key capable of signing this instruction, making governance rotations impossible. **Recommendation:** store an explicit governance/upgrade authority alongside the pool PDA, or require the pool program to call `set_pool_authority` via CPI and gate on `authority.is_signer` similar to the `release` fix.

## Operational Improvements

- Switch from the deprecated `token_interface::transfer` helper to the checked variant to pick up SPL Token 2022 rent and decimals checks for free.
- Emit explicit events on authority rotations and releases that include the destination account to aid indexing.
