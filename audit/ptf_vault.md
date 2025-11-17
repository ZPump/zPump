# Security Audit Report: ptf_vault

## Program Overview
- **Program ID**: `9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh`
- **Purpose**: Custody of SPL tokens for each pool
- **Language**: Rust (Anchor framework)

## Critical Security Issues

### 1. HIGH: Pool Authority Can Be Changed Without Timelock
**Severity**: HIGH (8/10)
**Location**: Lines 84-96

**Issue**: The `set_pool_authority` function allows the current pool authority to change the authority to any new address without any timelock, multi-sig, or additional safeguards.

**Code Reference**:
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
    state.pool_authority = new_pool_authority;
    Ok(())
}
```

**Why This Is High**:
- If the pool authority key is compromised, an attacker can immediately change it to their own key
- No recovery mechanism if the change is made in error
- The vault holds all user funds, so this is a single point of failure
- No event is emitted for this critical operation

**Recommendation**:
- Add a timelock (e.g., 7 days) before authority changes take effect
- Require multi-sig for authority changes
- Emit an event for authority changes
- Consider a two-step process (initiate + confirm)

### 2. MEDIUM: No Maximum Amount Checks on Release
**Severity**: MEDIUM (6/10)
**Location**: Lines 52-82

**Issue**: The `release` function doesn't check if the vault has sufficient balance before releasing tokens. While the SPL token program will enforce this, it's better to fail fast with a clear error.

**Code Reference**:
```rust
pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidReleaseAmount);
    // ... no balance check before transfer
    token_interface::transfer(cpi_ctx, amount)?;
}
```

**Why This Is Medium**:
- The SPL token program will reject if insufficient balance
- However, checking balance first provides:
  - Clearer error messages
  - Better gas efficiency (fail before CPI)
  - More explicit validation

**Recommendation**:
- Check vault token account balance before attempting transfer
- Return a specific error if insufficient balance

### 3. MEDIUM: Pool Authority Validation Could Be Stronger
**Severity**: MEDIUM (6/10)
**Location**: Lines 181-194

**Issue**: The `validate_pool_authority` function checks that the pool authority is a signer, matches the expected key, and is owned by the pool program. However, it doesn't verify that the pool authority is actually a valid PDA derived from the pool program.

**Code Reference**:
```rust
fn validate_pool_authority(pool_authority: &AccountInfo<'_>, expected: &Pubkey) -> Result<()> {
    require!(pool_authority.is_signer, VaultError::UnauthorizedCaller);
    require_keys_eq!(
        pool_authority.key(),
        *expected,
        VaultError::UnauthorizedCaller
    );
    require_keys_eq!(
        *pool_authority.owner,
        PTF_POOL_PROGRAM_ID,
        VaultError::UnauthorizedCaller
    );
    Ok(())
}
```

**Why This Is Medium**:
- The function checks ownership but not that it's a valid PDA
- A malicious program could create an account owned by the pool program
- Should verify the account is actually a PDA with correct seeds

**Recommendation**:
- Verify the pool_authority is a PDA derived from the pool program
- Check the PDA seeds match expected values
- Consider using Anchor's PDA constraints

### 4. LOW: Missing Events for Critical Operations
**Severity**: LOW (3/10)
**Location**: set_pool_authority

**Issue**: The `set_pool_authority` function doesn't emit an event, making it harder to track authority changes off-chain.

**Recommendation**:
- Add an event for authority changes:
```rust
#[event]
pub struct VaultAuthorityChanged {
    pub origin_mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
```

### 5. LOW: No Pause Mechanism
**Severity**: LOW (4/10)

**Issue**: The vault program doesn't have a pause mechanism for emergency situations.

**Why This Is Low**:
- The pool program may have pause functionality
- However, having pause at the vault level could be useful for emergencies
- Could prevent all releases if a critical bug is discovered

**Recommendation**:
- Consider adding a pause flag
- Only allow deposits when paused (to allow withdrawals)
- Require authority to unpause

## Positive Security Features

1. **Proper PDA Validation**: Good use of seeds and bumps for PDA derivation
2. **Account Ownership Checks**: Validates token account ownership
3. **Mint Validation**: Ensures deposits match the vault's origin mint
4. **Signer Verification**: Properly checks that pool authority is a signer
5. **Clear Error Types**: Well-defined error codes

## Recommendations Summary

1. **HIGH PRIORITY**: Add timelock and/or multi-sig for authority changes
2. **HIGH PRIORITY**: Emit events for all state changes
3. **MEDIUM PRIORITY**: Add balance checks before release
4. **MEDIUM PRIORITY**: Strengthen pool authority validation
5. **LOW PRIORITY**: Consider adding pause mechanism

## Overall Security Score: 7/10

The vault program is relatively simple and well-structured, but the lack of safeguards on authority changes is a significant concern given it holds all user funds.

