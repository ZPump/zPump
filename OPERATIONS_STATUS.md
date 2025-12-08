# Operations Testing Status

## ✅ Completed
1. **Shield** - ✅ Working with `shield_execute_raw` workaround
   - Implemented raw instruction workaround to bypass Anchor validation bug
   - All tests passing

## ⚠️ In Progress
2. **Unshield** - ❌ `nullifier_set` account ownership issue
   - Error: Account owned by `NativeLoader` (doesn't exist)
   - Anchor validates ownership before our initialization code runs
   - **Fix needed**: Ensure `nullifier_set` is initialized during pool initialization, or bypass Anchor validation

3. **Transfer** - ⚠️ Proof/note mismatch (not a program bug)
   - Error: `PublicInputMismatch` - nullifier mismatch
   - This is a proof generation issue, not a program bug
   - **Fix needed**: Verify proof generation logic

4. **TransferFrom** - ❌ Same access violation as shield
   - Error: `Access violation in stack frame 5 at address 0x200005fe8`
   - Same Anchor validation bug as shield
   - **Fix needed**: Apply same `execute_transfer_from_raw` workaround

## 📋 Next Steps
1. Fix unshield `nullifier_set` initialization
2. Apply `execute_transfer_from_raw` workaround for TransferFrom
3. Investigate transfer proof generation issue
4. Test batch operations once above are fixed
