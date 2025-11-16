# Fix 04: Mint Status Enforcement

**Priority:** CRITICAL - Must fix before production  
**Estimated Time:** 4-6 hours  
**Risk Level:** Medium  
**Dependencies:** Fixes 01, 02, 03 should be done first  

## Problem Summary

The pool program never checks `mint_mapping.status` before processing transactions. The factory can freeze mints, but the pool ignores this status, making the freeze mechanism ineffective.

## Impact

- **Severity:** Critical
- **Attack Complexity:** N/A (design flaw)
- **Impact:** Governance mechanism broken - cannot freeze compromised mints
- **Affected Operations:** shield, transfer, unshield

## Solution Overview

Add `mint_mapping` account to all relevant context structs and check `status == MintStatus::Active` at the start of each function.

## Step-by-Step Implementation

### Step 1: Add MintStatus Check Helper (Optional but Recommended)

**File:** `programs/pool/src/lib.rs`

**Location:** Add near top of `impl` block or as a module function

**Add:**
```rust
fn require_mint_active(mapping: &ptf_factory::MintMapping) -> Result<()> {
    require!(
        mapping.status == ptf_factory::MintStatus::Active as u8,
        PoolError::MintFrozen,
    );
    Ok(())
}
```

### Step 2: Add MintFrozen Error

**File:** `programs/pool/src/lib.rs`

**Location:** Error enum (around line 3000-3100)

**Add:**
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors
    #[msg("E_MINT_FROZEN")]
    MintFrozen,
}
```

### Step 3: Update Shield Context Struct

**File:** `programs/pool/src/lib.rs`

**Location:** Lines 1478-1510 (Shield struct)

**Current Code:**
```rust
#[derive(Accounts)]
pub struct Shield<'info> {
    // ... existing accounts
    // Note: mint_mapping is not included
}
```

**New Code:**
```rust
#[derive(Accounts)]
pub struct Shield<'info> {
    // ... existing accounts (keep all)
    
    // ADD: Mint mapping account
    #[account(
        seeds = [seeds::MINT_MAPPING, pool_state.load()?.origin_mint.as_ref()],
        bump = mint_mapping.bump,
        constraint = mint_mapping.origin_mint == pool_state.load()?.origin_mint @ PoolError::OriginMintMismatch
    )]
    pub mint_mapping: Account<'info, ptf_factory::MintMapping>,
    
    // ... rest of accounts
}
```

**Note:** You may need to adjust the constraint based on how `pool_state` is loaded in the struct. If `pool_state` is already loaded, use:
```rust
#[account(
    seeds = [ptf_common::seeds::MINT_MAPPING, origin_mint.key().as_ref()],
    bump = mint_mapping.bump
)]
pub mint_mapping: Account<'info, ptf_factory::MintMapping>,
```

### Step 4: Add Status Check to shield() Function

**File:** `programs/pool/src/lib.rs`

**Location:** Lines 223-227 (start of shield function)

**Current Code:**
```rust
pub fn shield<'info>(
    ctx: Context<'_, '_, '_, 'info, Shield<'info>>,
    args: ShieldArgs,
) -> Result<()> {
    let pool_loader = &ctx.accounts.pool_state;
    let mut pool_state = pool_loader.load_mut()?;
    // ... rest of function
}
```

**New Code:**
```rust
pub fn shield<'info>(
    ctx: Context<'_, '_, '_, 'info, Shield<'info>>,
    args: ShieldArgs,
) -> Result<()> {
    // ADD: Check mint status first
    let mint_mapping = ctx.accounts.mint_mapping.load()?;
    require_mint_active(&mint_mapping)?;
    
    let pool_loader = &ctx.accounts.pool_state;
    let mut pool_state = pool_loader.load_mut()?;
    // ... rest of function (no changes)
}
```

### Step 5: Update Transfer Context Struct

**File:** `programs/pool/src/lib.rs`

**Location:** Transfer struct (find around line 1320-1400)

**Add mint_mapping account:**
```rust
#[derive(Accounts)]
pub struct Transfer<'info> {
    // ... existing accounts
    
    // ADD: Mint mapping account (same as Shield)
    #[account(
        seeds = [ptf_common::seeds::MINT_MAPPING, origin_mint.key().as_ref()],
        bump = mint_mapping.bump
    )]
    pub mint_mapping: Account<'info, ptf_factory::MintMapping>,
    
    // ... rest of accounts
}
```

### Step 6: Add Status Check to transfer() Function

**File:** `programs/pool/src/lib.rs`

**Location:** Start of `transfer` function (around line 680)

**Add:**
```rust
pub fn transfer<'info>(
    // ... function signature
) -> Result<()> {
    // ADD: Check mint status first
    let mint_mapping = ctx.accounts.mint_mapping.load()?;
    require_mint_active(&mint_mapping)?;
    
    // ... rest of function (no changes)
}
```

### Step 7: Update Unshield Context Struct

**File:** `programs/pool/src/lib.rs`

**Location:** Unshield struct (find around line 900-1000)

**Add mint_mapping account:**
```rust
#[derive(Accounts)]
pub struct Unshield<'info> {
    // ... existing accounts
    
    // ADD: Mint mapping account (same as Shield)
    #[account(
        seeds = [ptf_common::seeds::MINT_MAPPING, pool_state.load()?.origin_mint.as_ref()],
        bump = mint_mapping.bump
    )]
    pub mint_mapping: Account<'info, ptf_factory::MintMapping>,
    
    // ... rest of accounts
}
```

### Step 8: Add Status Check to unshield() Function

**File:** `programs/pool/src/lib.rs`

**Location:** Start of `unshield` function (around line 850)

**Add:**
```rust
pub fn unshield<'info>(
    // ... function signature
) -> Result<()> {
    // ADD: Check mint status first
    let mint_mapping = ctx.accounts.mint_mapping.load()?;
    require_mint_active(&mint_mapping)?;
    
    // ... rest of function (no changes)
}
```

### Step 9: Update All Call Sites

**Objective:** Ensure all places that construct Shield/Transfer/Unshield instructions include mint_mapping.

**Locations to check:**
- E2E test scripts
- SDK/Client code
- Any transaction builders

**Action:** Search for usages and update to include mint_mapping account.

## Testing Plan

### Test 1: Verify Program Compiles

**Objective:** Ensure the program compiles with the changes.

**Steps:**
1. Build: `anchor build`
2. Check for compilation errors

**Expected Result:** Program compiles successfully.

### Test 2: Test Shield with Active Mint

**Objective:** Verify shield works when mint is active.

**Steps:**
1. Ensure mint is active (default state)
2. Run E2E test: `npx tsx web/app/scripts/wrap-unwrap-local.ts`
3. Verify shield succeeds

**Expected Result:** Shield succeeds.

### Test 3: Test Shield with Frozen Mint

**Objective:** Verify shield fails when mint is frozen.

**Create test:** `programs/pool/tests/mint_status.rs`

```rust
#[tokio::test]
async fn test_shield_fails_when_frozen() {
    // Setup: Initialize pool with mint
    
    // Freeze the mint via factory
    freeze_mapping_via_factory(&mint_key).await;
    
    // Attempt to shield - should fail
    let result = shield(&ctx, shield_args).await;
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), PoolError::MintFrozen);
}

#[tokio::test]
async fn test_transfer_fails_when_frozen() {
    // Similar test for transfer
}

#[tokio::test]
async fn test_unshield_fails_when_frozen() {
    // Similar test for unshield
}
```

**Expected Result:** All operations fail with `MintFrozen` when mint is frozen.

### Test 4: Test Thaw Restores Operations

**Objective:** Verify that thawing restores normal operations.

**Steps:**
1. Freeze mint
2. Verify operations fail
3. Thaw mint
4. Verify operations succeed again

**Expected Result:** Operations work after thaw.

### Test 5: Integration Test

**Objective:** Verify the fix doesn't break existing functionality.

**Steps:**
1. Run full E2E: `npx tsx web/app/scripts/browser-e2e.ts`
2. Verify all operations succeed (mint should be active)

**Expected Result:** All tests pass.

### Test 6: Update SDK/Client Code

**Objective:** Ensure all client code includes mint_mapping.

**Files to check:**
- `web/app/lib/sdk.ts` or similar
- Transaction builders
- Any code that constructs Shield/Transfer/Unshield instructions

**Action:** Update to include mint_mapping account in all transactions.

## Verification Checklist

- [ ] Code changes implemented
- [ ] Program compiles: `anchor build`
- [ ] MintFrozen error added
- [ ] All three functions (shield, transfer, unshield) check status
- [ ] Tests pass for active mint: `anchor test`
- [ ] Tests fail for frozen mint: `anchor test`
- [ ] Thaw restores operations: `anchor test`
- [ ] E2E tests pass: `npx tsx web/app/scripts/browser-e2e.ts`
- [ ] SDK/client code updated (if needed)

## Potential Issues and Solutions

### Issue 1: Struct Constraint Errors

**Symptom:** Anchor constraints fail when trying to load pool_state in struct.

**Solution:**
- Use `origin_mint.key()` directly if available in struct
- Or load pool_state first, then derive mint_mapping address
- Check existing struct patterns in the codebase

### Issue 2: Client Code Not Updated

**Symptom:** Transactions fail because mint_mapping is missing.

**Solution:**
- Update all transaction builders
- Add mint_mapping to SDK functions
- Update E2E tests to include mint_mapping

### Issue 3: Multiple Context Structs

**Symptom:** There may be multiple Shield/Transfer/Unshield structs or variants.

**Solution:**
- Search for all definitions
- Update all variants
- Check if any are in different modules

## Rollback Plan

If something breaks:

1. **Immediate:** Revert the changes:
   ```bash
   git checkout programs/pool/src/lib.rs
   ```

2. **Note:** Rolling back restores the vulnerability

3. **Debug:**
   - Check struct constraints
   - Verify mint_mapping account derivation
   - Check if all call sites are updated

## Expected Outcome

After this fix:
- ✅ Shield fails when mint is frozen (freeze works)
- ✅ Transfer fails when mint is frozen
- ✅ Unshield fails when mint is frozen
- ✅ Operations succeed when mint is active
- ✅ Freeze mechanism is effective

## Notes

- This fix requires coordination between factory and pool
- Factory is already correct - this fix makes pool respect it
- All client code must be updated to include mint_mapping
- This is a governance fix - critical for emergency response

## Next Steps

After this fix is verified:
1. Commit the changes
2. Update all client/SDK code
3. Move to Fix 05 (Shield Finalization)
4. Test freeze/thaw functionality end-to-end

