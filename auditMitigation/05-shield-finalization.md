# Fix 05: Shield Finalization Enforcement

**Priority:** HIGH - Should fix before production  
**Estimated Time:** 1 hour  
**Risk Level:** Low  
**Dependencies:** Fixes 01-04 can be done in any order, but recommended to do after core fixes  

## Problem Summary

The `shield()` function searches for a `shield_finalize_ledger` instruction in the transaction. If not found, it only logs a warning and continues, leaving `pending_shield` active and blocking future shields.

## Impact

- **Severity:** High
- **Attack Complexity:** Trivial
- **Impact:** Griefing attacks can prevent legitimate deposits
- **Affected Operations:** shield

## Solution Overview

Replace the warning with an error, making shield finalization mandatory. This prevents griefing attacks and ensures pool liveness.

## Step-by-Step Implementation

### Step 1: Add ShieldFinalizationRequired Error

**File:** `programs/pool/src/lib.rs`

**Location:** Error enum (around line 3000-3100)

**Add:**
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors
    #[msg("E_SHIELD_FINALIZATION_REQUIRED")]
    ShieldFinalizationRequired,
}
```

### Step 2: Update shield() Function

**File:** `programs/pool/src/lib.rs`

**Location:** Lines 434-436

**Current Code:**
```rust
if !finalize_found {
    msg!("shield finalize instruction not detected; skipping enforcement");
}
```

**New Code:**
```rust
if !finalize_found {
    return err!(PoolError::ShieldFinalizationRequired);
}
```

That's it! The change is very simple.

## Testing Plan

### Test 1: Verify Program Compiles

**Objective:** Ensure the program compiles with the changes.

**Steps:**
1. Build: `anchor build`
2. Check for compilation errors

**Expected Result:** Program compiles successfully.

### Test 2: Test Shield with Finalization

**Objective:** Verify shield works when finalization is included.

**Steps:**
1. Run E2E test: `npx tsx web/app/scripts/wrap-unwrap-local.ts`
2. Verify shield succeeds (should already include finalization)

**Expected Result:** Shield succeeds.

### Test 3: Test Shield without Finalization

**Objective:** Verify shield fails when finalization is missing.

**Create test:** `programs/pool/tests/shield_finalization.rs`

```rust
#[tokio::test]
async fn test_shield_requires_finalization() {
    // Setup: Initialize pool
    
    // Create shield instruction WITHOUT finalize instruction
    let shield_ix = Instruction {
        program_id: crate::id(),
        accounts: shield_accounts,
        data: shield_instruction_data,
    };
    
    // Submit transaction with only shield instruction
    let tx = Transaction::new_with_payer(&[shield_ix], Some(&payer.pubkey()));
    
    // This should fail
    let result = banks_client.process_transaction(tx).await;
    assert!(result.is_err());
    
    // Verify error is ShieldFinalizationRequired
    // (check error code)
}

#[tokio::test]
async fn test_shield_succeeds_with_finalization() {
    // Setup: Initialize pool
    
    // Create shield instruction WITH finalize instruction
    let shield_ix = create_shield_instruction();
    let finalize_ix = create_shield_finalize_instruction();
    
    // Submit transaction with both instructions
    let tx = Transaction::new_with_payer(
        &[shield_ix, finalize_ix],
        Some(&payer.pubkey())
    );
    
    // This should succeed
    let result = banks_client.process_transaction(tx).await;
    assert!(result.is_ok());
}
```

**Expected Result:** Shield fails without finalization, succeeds with it.

### Test 4: Integration Test

**Objective:** Verify existing functionality still works.

**Steps:**
1. Run full E2E: `npx tsx web/app/scripts/browser-e2e.ts`
2. Verify all operations succeed (should already include finalization)

**Expected Result:** All tests pass.

### Test 5: Verify Client Code Includes Finalization

**Objective:** Ensure all client code that calls shield includes finalization.

**Files to check:**
- `web/app/lib/sdk.ts` or similar
- Transaction builders
- Any code that constructs shield transactions

**Action:** Verify all shield calls include the finalize instruction.

## Verification Checklist

- [ ] Code changes implemented
- [ ] Program compiles: `anchor build`
- [ ] ShieldFinalizationRequired error added
- [ ] Shield fails without finalization: `anchor test`
- [ ] Shield succeeds with finalization: `anchor test`
- [ ] E2E tests pass: `npx tsx web/app/scripts/browser-e2e.ts`
- [ ] Client code includes finalization (verify)

## Potential Issues and Solutions

### Issue 1: Existing Transactions Don't Include Finalization

**Symptom:** Existing E2E tests fail because they don't include finalization.

**Solution:**
- Update all transaction builders to include finalization
- Check SDK code - it should already include it (based on audit)
- Update any test code that constructs shield transactions directly

### Issue 2: Transaction Size Limits

**Symptom:** Transactions with both shield and finalize are too large.

**Solution:**
- This is unlikely (both instructions should fit)
- If it happens, consider using versioned transactions
- Or optimize instruction data size

### Issue 3: Instruction Ordering

**Symptom:** Finalize instruction must be in same transaction as shield.

**Solution:**
- This is the intended behavior - both must be in one transaction
- Ensure all client code constructs transactions correctly
- Update documentation to clarify this requirement

## Rollback Plan

If something breaks:

1. **Immediate:** Revert the changes:
   ```bash
   git checkout programs/pool/src/lib.rs
   ```

2. **Note:** Rolling back restores the vulnerability (optional finalization)

3. **Debug:**
   - Check if client code includes finalization
   - Verify transaction construction
   - Check instruction ordering

## Expected Outcome

After this fix:
- ✅ Shield fails without finalization (griefing prevented)
- ✅ Shield succeeds with finalization (existing functionality preserved)
- ✅ Pool liveness guaranteed (no stuck pending shields)
- ✅ Griefing attack fixed

## Notes

- This is a very simple fix (2 lines changed)
- Low risk - should not break existing functionality if client code is correct
- High impact - prevents griefing attacks
- All existing code should already include finalization (check to be sure)

## Next Steps

After this fix is verified:
1. Commit the changes
2. Verify all client code includes finalization
3. All critical fixes are complete!
4. Move to testing and deployment checklist

