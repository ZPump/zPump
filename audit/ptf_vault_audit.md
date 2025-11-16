# Security Audit Report: ptf_vault

**Program ID:** `9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh`  
**Audit Date:** 2025-11-16  
**Severity Grade:** **F (Critical)**

## Executive Summary

The `ptf_vault` program contains a **critical vulnerability** that allows unauthorized withdrawal of all vault funds. The `release` instruction only verifies that the provided `pool_authority` public key matches the stored authority, but does not verify that the account is actually a signer or that it belongs to the pool program. This allows any attacker to drain the entire vault by calling the instruction directly with the public `pool_state` account.

## Critical Issues

### CRITICAL-001: Vault Drain via Unauthorized Release

**Severity:** Critical  
**Location:** `programs/vault/src/lib.rs:49-56`

**Description:**
The `release` function in `ptf_vault` only performs a public key comparison to verify authorization:

```rust
pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidReleaseAmount);
    let vault_state = &ctx.accounts.vault_state;
    require_keys_eq!(
        ctx.accounts.pool_authority.key(),
        vault_state.pool_authority,
        VaultError::UnauthorizedCaller,
    );
    // ... rest of function
}
```

**Vulnerability:**
The code only checks that `pool_authority.key()` matches `vault_state.pool_authority`, but:
1. It does NOT require `pool_authority.is_signer`
2. It does NOT verify that `pool_authority.owner == ptf_pool::ID`
3. The `pool_authority` account is marked as `/// CHECK: Pool authority must be provided by the caller program.` in the `Release` struct, meaning Anchor performs no validation

**Attack Scenario:**
1. Attacker obtains the public key of any `pool_state` account (this is public on-chain data)
2. Attacker constructs a transaction calling `ptf_vault::release` with:
   - `pool_authority`: The public `pool_state` account (not a signer)
   - `amount`: The entire vault balance
   - `destination_token_account`: Attacker's own token account
3. The transaction succeeds because the public key matches, even though the account is not a signer
4. Attacker drains the entire vault

**Impact:**
- **Complete loss of all vault funds** for any mint
- No authentication required
- Trivial to exploit
- Affects all pools immediately upon deployment

**Proof of Concept:**
```rust
// Attacker's transaction
let release_ix = Instruction {
    program_id: ptf_vault::ID,
    accounts: vec![
        AccountMeta::new(vault_state, false),
        AccountMeta::new(vault_token_account, false),
        AccountMeta::new(attacker_token_account, false),
        AccountMeta::new_readonly(pool_state_pubkey, false), // NOT A SIGNER!
        AccountMeta::new_readonly(token_program, false),
    ],
    data: release_instruction_data,
};
// This will succeed and drain the vault
```

**Recommended Fix:**
```rust
pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidReleaseAmount);
    let vault_state = &ctx.accounts.vault_state;
    
    // CRITICAL: Require pool_authority to be a signer
    require!(
        ctx.accounts.pool_authority.is_signer,
        VaultError::UnauthorizedCaller,
    );
    
    // CRITICAL: Verify pool_authority is owned by the pool program
    require_keys_eq!(
        *ctx.accounts.pool_authority.owner,
        ptf_pool::ID,
        VaultError::UnauthorizedCaller,
    );
    
    // Verify the public key matches
    require_keys_eq!(
        ctx.accounts.pool_authority.key(),
        vault_state.pool_authority,
        VaultError::UnauthorizedCaller,
    );
    
    // ... rest of function
}
```

**Alternative Fix (More Secure):**
Use a PDA constraint in the `Release` struct to ensure the pool_authority is derived from the pool program:

```rust
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Must be the pool PDA and must be a signer
    #[account(
        signer,
        constraint = pool_authority.key() == vault_state.pool_authority @ VaultError::UnauthorizedCaller,
        constraint = pool_authority.owner == &ptf_pool::ID @ VaultError::UnauthorizedCaller
    )]
    pub pool_authority: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
```

## Additional Security Observations

### OBS-001: SetPoolAuthority Authorization

**Location:** `programs/vault/src/lib.rs:85-97`

The `set_pool_authority` function requires the caller to be the current `pool_authority`. This is reasonable, but consider:
- If the pool program is upgraded or compromised, the authority could be changed
- Consider adding a timelock or multi-sig requirement for authority changes

### OBS-002: Deposit Validation

**Location:** `programs/vault/src/lib.rs:22-47`

The `deposit` function correctly validates:
- Amount > 0
- Mint matches vault's origin_mint
- Uses proper token transfer CPI

No issues found in deposit logic.

## Recommendations

1. **IMMEDIATE:** Fix CRITICAL-001 before any mainnet deployment
2. **HIGH:** Add comprehensive integration tests that verify unauthorized release attempts fail
3. **MEDIUM:** Consider adding events/logging for all release operations for monitoring
4. **MEDIUM:** Add rate limiting or maximum release amount per transaction if needed
5. **LOW:** Consider adding a pause mechanism for emergency stops

## Testing Recommendations

1. Create a test that attempts to call `release` with `pool_authority` as a non-signer - should fail
2. Create a test that attempts to call `release` with `pool_authority` owned by wrong program - should fail
3. Create a test that verifies only the pool program PDA can successfully call `release`
4. Test that the pool program's CPI call to `release` works correctly after the fix

## Conclusion

The `ptf_vault` program has a **critical vulnerability** that allows complete vault drainage. This must be fixed immediately before any production deployment. The fix is straightforward but requires careful implementation and thorough testing.

