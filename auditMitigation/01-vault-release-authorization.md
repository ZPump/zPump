# Fix 01: Vault Release Authorization

**Priority:** CRITICAL - Must fix first  
**Estimated Time:** 1-2 hours  
**Risk Level:** Low  
**Dependencies:** None  

## Problem Summary

The `ptf_vault::release` instruction only verifies that `pool_authority.key()` matches `vault_state.pool_authority`, but doesn't require the account to be a signer or verify it's owned by the pool program. Anyone can drain the entire vault by calling release directly with the public `pool_state` account.

## Impact

- **Severity:** Critical
- **Attack Complexity:** Trivial
- **Impact:** Complete vault drainage
- **Affected Operations:** All unshield operations

## Solution Overview

Add two checks to the `release` function:
1. Require `pool_authority.is_signer == true`
2. Verify `pool_authority.owner == ptf_pool::ID`

This ensures only the pool program's PDA can call release (when used correctly via CPI).

## Step-by-Step Implementation

### Step 1: Update the Release Function

**File:** `programs/vault/src/lib.rs`

**Location:** Lines 49-56

**Current Code:**
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

**New Code:**
```rust
pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidReleaseAmount);
    let vault_state = &ctx.accounts.vault_state;
    
    // CRITICAL FIX: Require pool_authority to be a signer
    require!(
        ctx.accounts.pool_authority.is_signer,
        VaultError::UnauthorizedCaller,
    );
    
    // CRITICAL FIX: Verify pool_authority is owned by the pool program
    require_keys_eq!(
        *ctx.accounts.pool_authority.owner,
        ptf_pool::ID,
        VaultError::UnauthorizedCaller,
    );
    
    // Existing check (keep this)
    require_keys_eq!(
        ctx.accounts.pool_authority.key(),
        vault_state.pool_authority,
        VaultError::UnauthorizedCaller,
    );
    
    // ... rest of function (no changes needed)
}
```

### Step 2: Add Import for Pool Program ID

**File:** `programs/vault/src/lib.rs`

**Location:** Top of file (add after existing imports, around line 1-10)

**Add:**
```rust
use ptf_pool::ID as POOL_PROGRAM_ID;
```

**Note:** If the import path is different, adjust accordingly. You may need to check how to reference the pool program ID from the vault program.

### Step 3: Update Context Constraint (Optional but Recommended)

**File:** `programs/vault/src/lib.rs`

**Location:** Lines 131-142 (Release struct)

**Current Code:**
```rust
#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, seeds = [seeds::VAULT, vault_state.origin_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Pool authority must be provided by the caller program.
    pub pool_authority: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
```

**New Code:**
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

**Note:** If Anchor constraints don't support `owner` checks in the struct, keep the manual checks in the function and just add `signer` constraint here.

## Testing Plan

### Test 1: Verify Pool's CPI Call Still Works

**Objective:** Ensure the pool program's CPI call to release still works correctly.

**Steps:**
1. Build both programs: `anchor build`
2. Deploy to local validator
3. Run existing E2E tests: `npx tsx web/app/scripts/wrap-unwrap-local.ts`
4. Verify unshield operations succeed

**Expected Result:** All tests pass. The pool uses `invoke_signed` with PDA seeds, which makes the PDA a signer, so this should work.

### Test 2: Verify Direct Call Fails (Security Test)

**Objective:** Verify that a direct call to release without proper authorization fails.

**Create test file:** `programs/vault/tests/vault_unauthorized_release.rs`

```rust
use anchor_lang::prelude::*;
use ptf_vault::program::PtfVault;

#[tokio::test]
async fn test_unauthorized_release_fails() {
    // Setup test context with vault initialized
    
    // Attempt to call release with pool_authority as non-signer
    // This should fail with UnauthorizedCaller
    
    // Attempt to call release with pool_authority owned by wrong program
    // This should fail with UnauthorizedCaller
}
```

**Expected Result:** Both unauthorized attempts fail.

### Test 3: Integration Test

**Objective:** Verify the fix doesn't break existing functionality.

**Steps:**
1. Run full E2E test suite: `npx tsx web/app/scripts/browser-e2e.ts`
2. Verify all operations succeed

**Expected Result:** All tests pass.

## Verification Checklist

- [ ] Code changes implemented
- [ ] Programs compile: `anchor build`
- [ ] Local validator tests pass: `anchor test`
- [ ] E2E tests pass: `npx tsx web/app/scripts/wrap-unwrap-local.ts`
- [ ] Browser E2E tests pass: `npx tsx web/app/scripts/browser-e2e.ts`
- [ ] Unauthorized release test fails as expected
- [ ] All existing functionality still works

## Rollback Plan

If something breaks:

1. **Immediate:** Revert the changes:
   ```bash
   git checkout programs/vault/src/lib.rs
   ```

2. **Verify:** Run tests to confirm everything works again

3. **Debug:** Check if the import path for `ptf_pool::ID` is correct

## Expected Outcome

After this fix:
- ✅ Direct unauthorized calls to `release` fail
- ✅ Pool program's CPI calls still work (uses PDA signing)
- ✅ All existing functionality preserved
- ✅ Critical vulnerability fixed

## Notes

- The pool program correctly uses `invoke_signed` with PDA seeds, so its calls will still work
- This fix only prevents direct unauthorized calls
- No changes needed to the pool program itself
- This is a low-risk change that shouldn't break anything

## Next Steps

After this fix is verified:
1. Commit the changes
2. Move to Fix 02 (Proof Verification)
3. Continue with remaining fixes in order

