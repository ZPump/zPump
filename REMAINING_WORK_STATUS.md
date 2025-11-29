# Remaining Work Status - DEX Implementation

## ✅ Completed

### Phase 1: Program Foundation ✅
- [x] Created `programs/dex/` structure
- [x] Defined account structures (PoolState with public/private reserve tracking)
- [x] Implemented `create_pool` instruction (handles public tokens)
- [x] Pool PDA setup for private position management
- [x] Added to `Anchor.toml` workspace
- [x] Deployed and tested basic pool creation (public tokens)

### Phase 2: Liquidity Operations ✅ (Partially)
- [x] Implemented `add_liquidity` (handles public tokens) ✅
- [x] **Lifetime issue RESOLVED** for `add_liquidity` ✅
- [x] zToken CPI calls enabled in `add_liquidity` ✅
- [x] Implemented `remove_liquidity` (handles public tokens) ✅
- [x] LP token minting/burning logic
- [x] Pool PDA private position management structure
- [ ] **TODO:** Enable zToken CPIs in `remove_liquidity` (commented out)

### Phase 3: Swap Logic ✅ (Partially)
- [x] Implemented `swap` instruction for public tokens ✅
- [x] Constant product formula (handles mixed reserves)
- [x] Fee calculation and distribution structure
- [ ] **TODO:** Enable all zToken CPIs in `swap` (commented out)
  - [ ] zToken → zToken (transfer both sides)
  - [ ] Public → zToken (shield output)
  - [ ] zToken → Public (transfer from pool)

### Phase 5: SDK Integration ✅ (Partially)
- [x] Added DEX functions to `sdk.ts`
- [x] Pool state fetching (public + private reserves)
- [x] Price calculations
- [x] Integration with proof client helpers
- [x] Helper functions (isZToken, etc.)
- [x] SDK adds payer/system/rent to remaining_accounts for `add_liquidity`
- [ ] **TODO:** Update SDK for `remove_liquidity` (add accounts to remaining_accounts)
- [ ] **TODO:** Update SDK for `swap` (add accounts to remaining_accounts)
- [ ] **TODO:** Update SDK for `create_pool` (add accounts to remaining_accounts)

## ❌ Pending Work

### Critical: Enable zToken CPIs

#### 1. `remove_liquidity.rs` - Transfer CPIs (HIGH PRIORITY)
**Status:** CPIs commented out, lifetime issue resolved pattern ready to apply

**What needs to be done:**
- [ ] Apply the same Vec pattern used in `add_liquidity`:
  - Create helper function `handle_ztoken_remove_liquidity` similar to `handle_ztoken_liquidity`
  - Convert `ctx.remaining_accounts.to_vec()` when calling helper
  - Handle pool PDA signing (pool PDA is sender, not user)
- [ ] Enable transfer CPI for token A (pool PDA → user)
- [ ] Enable transfer CPI for token B (pool PDA → user)
- [ ] Update SDK to add payer/system/rent to remaining_accounts for `remove_liquidity`

**Files to modify:**
- `programs/dex/src/instructions/remove_liquidity.rs` - Enable CPIs
- `web/app/lib/sdk.ts` - Update `removeDexLiquidity` function

---

#### 2. `swap.rs` - Multiple CPI Types (HIGH PRIORITY)
**Status:** All CPIs commented out, lifetime issue resolved pattern ready to apply

**What needs to be done:**

**Swap Type 1: zToken → zToken**
- [ ] Enable transfer CPI for input (user → pool PDA)
- [ ] Enable transfer CPI for output (pool PDA → user)
- [ ] Apply Vec pattern with helper functions

**Swap Type 2: Public → zToken**
- [ ] Enable shield CPI for output (public tokens → zTokens)
- [ ] Create helper function `handle_ztoken_shield` using Vec pattern
- [ ] Handle shield-specific accounts (vault, etc.)

**Swap Type 3: zToken → Public**
- [ ] Enable transfer CPI for input (user → pool PDA)
- [ ] Transfer public tokens from pool to user (already implemented)

**Swap Type 4: Public → Public**
- [x] Already implemented ✅

- [ ] Update SDK to add payer/system/rent to remaining_accounts for `swap`
- [ ] Update SDK to handle different account sets for different swap types

**Files to modify:**
- `programs/dex/src/instructions/swap.rs` - Enable all CPIs
- `programs/dex/src/ztoken_cpi.rs` - May need shield helper function
- `web/app/lib/sdk.ts` - Update `swapDex` function

---

#### 3. `create_pool.rs` - Shield CPIs (MEDIUM PRIORITY)
**Status:** Shield CPIs commented out, lifetime issue resolved pattern ready to apply

**What needs to be done:**
- [ ] Create helper function `handle_ztoken_shield` using Vec pattern
- [ ] Enable shield CPI for token A (if zToken)
- [ ] Enable shield CPI for token B (if zToken)
- [ ] Handle shield-specific accounts (14 accounts vs 7 for transfer)
- [ ] Update SDK to add payer/system/rent/vault accounts to remaining_accounts for `create_pool`

**Files to modify:**
- `programs/dex/src/instructions/create_pool.rs` - Enable shield CPIs
- `programs/dex/src/ztoken_cpi.rs` - Ensure shield helper works with Vec pattern
- `web/app/lib/sdk.ts` - Update `createDexPool` function

---

### SDK Updates Needed

#### `removeDexLiquidity` in `sdk.ts`
- [ ] Add payer, system_program, rent to `remaining_accounts` (same pattern as `add_liquidity`)
- [ ] Generate transfer proofs when zTokens are involved
- [ ] Pass `TransferArgs` as instruction parameters

#### `swapDex` in `sdk.ts`
- [ ] Add payer, system_program, rent to `remaining_accounts`
- [ ] Handle different account sets for different swap types:
  - zToken → zToken: 2 sets of transfer accounts + common accounts
  - Public → zToken: shield accounts + common accounts
  - zToken → Public: transfer accounts + common accounts
- [ ] Generate appropriate proofs (transfer or shield) based on swap type

#### `createDexPool` in `sdk.ts`
- [ ] Add payer, system_program, rent, vault accounts to `remaining_accounts`
- [ ] Generate shield proofs when zTokens are involved
- [ ] Pass `ShieldArgs` as instruction parameters

---

### Phase 4: Fee Collection (LOW PRIORITY)
- [ ] Implement `collect_fees` instruction
- [ ] Protocol fee accumulator logic
- [ ] LP fee distribution logic
- [ ] Test fee collection

**Note:** Fee collection can be implemented later, it's not blocking zToken functionality.

---

### Phase 7: Testing (CRITICAL - After CPIs Enabled)

#### Low-Level Tests
- [ ] Test `remove_liquidity` with zTokens (after CPIs enabled)
- [ ] Test all swap types:
  - [ ] zToken → zToken
  - [ ] Public → zToken
  - [ ] zToken → Public
- [ ] Test `create_pool` with zTokens (after shield CPIs enabled)
- [ ] Edge cases for all zToken operations

#### High-Level Tests
- [ ] Full user flows via SDK with zTokens
- [ ] Multiple users, multiple pools
- [ ] zToken integration flows end-to-end

---

## Implementation Pattern (Reuse from `add_liquidity`)

The solution pattern that works:

```rust
// 1. Convert remaining_accounts to Vec (breaks lifetime dependency)
let (commitment, amount) = handle_ztoken_helper(
    ctx.remaining_accounts.to_vec(),  // ← KEY: .to_vec() breaks lifetime
    &payer_pubkey,
    &token_mint,
    &POOL_PROGRAM_ID,
    transfer_args,
    &pool_state_key,
    current_reserve,
    amount,
    account_offset,
)?;

// 2. Helper function takes Vec (owned, not reference)
fn handle_ztoken_helper<'info>(
    remaining_accounts: Vec<AccountInfo<'info>>,  // Owned Vec
    // ... other params
) -> Result<(Option<[u8; 32]>, Option<u64>)> {
    let ra = remaining_accounts.as_slice();
    // ... do all CPI work
    // Return only scalar values
}

// 3. Re-access ctx.accounts after helper returns (no conflict!)
let pool_state = &mut ctx.accounts.pool_state;
pool_state.update_private_reserve(commitment, amount);
```

---

## Priority Order

1. **HIGH:** Enable `remove_liquidity` zToken CPIs (similar to `add_liquidity`, easier)
2. **HIGH:** Enable `swap` zToken CPIs (more complex, multiple types)
3. **MEDIUM:** Enable `create_pool` shield CPIs (requires shield helper)
4. **LOW:** Implement `collect_fees` (can be done later)
5. **CRITICAL:** Run full test suite after all CPIs enabled

---

## Files That Need Updates

### Program Files
- `programs/dex/src/instructions/remove_liquidity.rs` - Enable transfer CPIs
- `programs/dex/src/instructions/swap.rs` - Enable all CPI types
- `programs/dex/src/instructions/create_pool.rs` - Enable shield CPIs
- `programs/dex/src/ztoken_cpi.rs` - May need shield helper with Vec pattern

### SDK Files
- `web/app/lib/sdk.ts`:
  - `removeDexLiquidity()` - Add accounts to remaining_accounts
  - `swapDex()` - Add accounts, handle different swap types
  - `createDexPool()` - Add accounts for shield operations

---

## Next Steps

1. **Apply Vec pattern to `remove_liquidity`** (easiest, most similar to `add_liquidity`)
2. **Apply Vec pattern to `swap`** (more complex but follows same pattern)
3. **Apply Vec pattern to `create_pool`** (requires shield helper)
4. **Test everything** with full test suite

The lifetime solution is proven and can be reused for all remaining CPIs!

