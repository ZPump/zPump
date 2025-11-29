# What's Left To Complete - DEX Implementation

## ✅ What's Done

1. **Lifetime Issue SOLVED** ✅
   - Solution: Convert `ctx.remaining_accounts.to_vec()` to break lifetime dependency
   - Pattern proven and working in `add_liquidity`

2. **`add_liquidity` - COMPLETE** ✅
   - zToken CPIs enabled and working
   - Helper function `handle_ztoken_liquidity` implemented
   - SDK adds payer/system/rent to remaining_accounts
   - Compiles successfully

3. **Program Structure - COMPLETE** ✅
   - All instruction handlers exist
   - Account structures defined
   - Basic logic implemented

---

## ❌ What's Left

### HIGH PRIORITY

#### 1. Enable `remove_liquidity` zToken CPIs
**Status:** CPIs are commented out  
**Pattern:** Same as `add_liquidity` - apply Vec conversion pattern  
**Complexity:** Medium (similar to add_liquidity, but pool PDA is sender)

**Tasks:**
- [ ] Create `handle_ztoken_remove_liquidity` helper function (like `handle_ztoken_liquidity`)
- [ ] Convert `ctx.remaining_accounts.to_vec()` when calling helper
- [ ] Handle pool PDA signing (pool is sender, user is recipient)
- [ ] Enable transfer CPI for token A (pool PDA → user)
- [ ] Enable transfer CPI for token B (pool PDA → user)
- [ ] Update SDK `removeDexLiquidity()` to add payer/system/rent to remaining_accounts

**Files:**
- `programs/dex/src/instructions/remove_liquidity.rs`
- `web/app/lib/sdk.ts` (removeDexLiquidity function)

---

#### 2. Enable `swap` zToken CPIs  
**Status:** All CPIs are commented out  
**Pattern:** Same Vec conversion pattern  
**Complexity:** High (multiple swap types)

**Swap Types Needed:**

**Type 1: zToken → zToken**
- [ ] Transfer CPI for input (user → pool PDA)
- [ ] Transfer CPI for output (pool PDA → user)
- [ ] Helper function `handle_ztoken_transfer_for_swap`

**Type 2: Public → zToken**
- [ ] Shield CPI for output (shield public tokens to zTokens)
- [ ] Helper function `handle_ztoken_shield_for_swap`
- [ ] Handle shield-specific accounts (14 accounts)

**Type 3: zToken → Public**
- [ ] Transfer CPI for input (user → pool PDA)
- [ ] Public transfer already works ✅

**Type 4: Public → Public**
- [x] Already implemented ✅

**Tasks:**
- [ ] Create helper functions for each swap type using Vec pattern
- [ ] Update SDK `swapDex()` to:
  - Add payer/system/rent to remaining_accounts
  - Handle different account sets per swap type
  - Generate appropriate proofs (transfer vs shield)

**Files:**
- `programs/dex/src/instructions/swap.rs`
- `programs/dex/src/ztoken_cpi.rs` (may need shield helper)
- `web/app/lib/sdk.ts` (swapDex function)

---

#### 3. Enable `create_pool` Shield CPIs
**Status:** Shield CPIs are commented out  
**Pattern:** Same Vec conversion pattern  
**Complexity:** Medium (shield requires more accounts than transfer)

**Tasks:**
- [ ] Create `handle_ztoken_shield` helper function using Vec pattern
- [ ] Handle shield-specific accounts (14 accounts vs 7 for transfer)
- [ ] Enable shield CPI for token A (if zToken)
- [ ] Enable shield CPI for token B (if zToken)
- [ ] Update SDK `createDexPool()` to:
  - Add payer/system/rent/vault accounts to remaining_accounts
  - Generate shield proofs
  - Pass ShieldArgs as instruction parameters

**Files:**
- `programs/dex/src/instructions/create_pool.rs`
- `programs/dex/src/ztoken_cpi.rs` (shield helper)
- `web/app/lib/sdk.ts` (createDexPool function)

---

### MEDIUM PRIORITY

#### 4. Implement `collect_fees` for zTokens
**Status:** TODO comments exist  
**Complexity:** Low (can be done later)

**Tasks:**
- [ ] Handle zToken protocol fee collection (if needed)
- [ ] Use Vec pattern if mixing ctx.accounts and remaining_accounts

**Files:**
- `programs/dex/src/instructions/collect_fees.rs`

---

### CRITICAL: Testing

#### 5. Run Full Test Suite
**Status:** Not yet run after lifetime fix

**Tasks:**
- [ ] Test `add_liquidity` with zTokens (should work now)
- [ ] Test `remove_liquidity` with zTokens (after CPIs enabled)
- [ ] Test all swap types (after CPIs enabled)
- [ ] Test `create_pool` with zTokens (after shield CPIs enabled)
- [ ] Edge cases for all zToken operations
- [ ] Run `run-full-test-suite.sh` end-to-end

**Test Files:**
- `web/app/scripts/dex-lowlevel-e2e.ts`
- `web/app/scripts/dex-highlevel-e2e.ts`

---

## Implementation Pattern (Copy-Paste Ready)

The proven pattern from `add_liquidity`:

```rust
// In instruction handler:
let (commitment, amount) = handle_ztoken_helper(
    ctx.remaining_accounts.to_vec(),  // ← KEY: .to_vec()
    &payer_pubkey,
    &token_mint,
    &POOL_PROGRAM_ID,
    transfer_args,
    &pool_state_key,
    current_reserve,
    amount,
    account_offset,
)?;

// Helper function (can reuse structure):
fn handle_ztoken_helper<'info>(
    remaining_accounts: Vec<AccountInfo<'info>>,  // Owned Vec
    // ... params
) -> Result<(Option<[u8; 32]>, Option<u64>)> {
    let ra = remaining_accounts.as_slice();
    // ... parse, build CPI, invoke
    // Return only scalar values
}
```

---

## Priority Order

1. **`remove_liquidity`** - Easiest (most similar to `add_liquidity`)
2. **`swap`** - More complex but same pattern
3. **`create_pool`** - Requires shield helper
4. **Testing** - Run full suite after all enabled
5. **`collect_fees`** - Can be done later

---

## Summary

**Completed:** Lifetime solution ✅, `add_liquidity` CPIs ✅  
**Remaining:** 3 instruction CPIs to enable + SDK updates + testing

The hard part (lifetime issue) is solved. The rest is applying the same pattern to the remaining instructions.

