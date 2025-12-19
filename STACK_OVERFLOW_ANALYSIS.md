# Stack Overflow Analysis and Recommendations

## Current Situation

**Problem**: `execute_shield_v2` stack overflow at address `0x200007af0` in frame 7

**What We've Tried:**
1. ✅ Moved wrapper creation to helper function (`execute_shield_impl_with_wrappers`)
2. ✅ Split helper into multiple smaller helpers (one per wrapper group)
3. ✅ Reduced main function stack usage (overflow moved from frame 5 to frame 7)

**Current Issue**: All wrappers must be alive simultaneously for `execute_shield_impl` call, so they're all on the stack at once.

## Key Insight: Unused Parameters

Looking at `execute_shield_impl` signature, several parameters are prefixed with `_`, meaning they're **not actually used**:

- `_nullifier_set: &UncheckedAccount<'info>` - **NOT USED**
- `_payer_info: &'info AccountInfo<'info>` - **NOT USED** (comment: "unused, kept for API consistency")
- `_origin_mint: &InterfaceAccount<'info, Mint>` - **NOT USED** (comment: "InterfaceAccount has invalid internal reference")
- `_mint_mapping: &Account<'info, MintMapping>` - **NOT USED**
- `_factory_state: &UncheckedAccount<'info>` - **NOT USED**

## Recommended Solution: Pass AccountInfo for Unused Parameters

**Strategy**: For parameters that are unused or only need `.key()` or `.to_account_info()`, pass `AccountInfo` directly instead of creating typed wrappers.

### Implementation Plan

1. **Modify `execute_shield_impl` signature** to accept `AccountInfo` for unused parameters:
   ```rust
   fn execute_shield_impl<'info, 'accs>(
       // ... existing parameters ...
       nullifier_set_info: &'info AccountInfo<'info>,  // Changed from &UncheckedAccount
       // ... 
       origin_mint_info: &'info AccountInfo<'info>,    // Already passed, remove _origin_mint
       mint_mapping_info: &'info AccountInfo<'info>,   // Changed from &Account
       factory_state_info: &'info AccountInfo<'info>, // Changed from &UncheckedAccount
       // ... rest unchanged ...
   )
   ```

2. **Update `execute_shield_impl_with_wrappers`** to skip creating wrappers for unused parameters:
   - Don't create `nullifier_set_wrapper` - pass `nullifier_set_info` directly
   - Don't create `origin_mint_wrapper` - already passing `origin_mint_info`
   - Don't create `mint_mapping_account` - pass `mint_mapping_info` directly
   - Don't create `factory_state_wrapper` - pass `factory_state_info` directly

3. **Update `execute_shield_impl` body** to use AccountInfo directly where needed:
   - If only `.key()` is needed, use `account_info.key()`
   - If only `.to_account_info()` is needed, use the AccountInfo directly

### Expected Impact

**Stack Reduction**: Removing 4 wrapper creations should save approximately:
- `UncheckedAccount` = ~32 bytes each × 2 = 64 bytes
- `Account<MintMapping>` = ~100+ bytes
- `InterfaceAccount<Mint>` = ~100+ bytes
- **Total: ~264+ bytes saved**

This should bring us from `0x200007af0` (overflow) to below the 4KB limit.

### Alternative: If Modification is Too Risky

If modifying `execute_shield_impl` signature is too risky (might break other callers), we can:

1. **Create a new function** `execute_shield_impl_optimized` that accepts AccountInfo for unused parameters
2. **Update `execute_shield_impl`** to call the optimized version internally
3. **Keep existing `execute_shield_impl`** signature for backward compatibility

## Risk Assessment

**Low Risk**: 
- Parameters are already unused (prefixed with `_`)
- We're just changing the type from wrapper to AccountInfo
- AccountInfo is more primitive and uses less stack

**Medium Risk**:
- Need to verify no other code calls `execute_shield_impl` with these wrappers
- Need to ensure AccountInfo is sufficient for any operations needed

## Caller Analysis

Found 2 callers of `execute_shield_impl`:
1. `execute_shield_impl_with_wrappers` (line 6738) - Our new helper
2. `execute_shield_core` (line 7592) - Uses `ctx.accounts` from Shield struct

**Both callers can be updated** to pass AccountInfo for unused parameters:
- `execute_shield_core` can use `ctx.accounts.nullifier_set.to_account_info()` etc.
- `execute_shield_impl_with_wrappers` can skip creating those wrappers

## Next Steps

1. ✅ **Verify unused parameters** - Confirmed: prefixed with `_` in signature
2. ✅ **Check other callers** - Found 2 callers, both can be updated
3. **Implement changes** - Modify signature and update both callers
4. **Test** - Verify stack overflow is resolved

## Implementation Priority

**HIGH PRIORITY** - This is the most promising approach because:
- Low risk (parameters already unused)
- High impact (~264+ bytes saved)
- Minimal code changes needed
- No architectural changes required

## Fallback Options

If this doesn't work:

1. **Further reduce wrappers** - Check if any other wrappers can be passed as AccountInfo
2. **Split `execute_shield_impl`** - Break into smaller functions that don't need all wrappers
3. **Use Box for some wrappers** - Move larger wrappers to heap (but Anchor types may not support this)
4. **Architectural change** - Consider if the instruction can be split into multiple smaller instructions

