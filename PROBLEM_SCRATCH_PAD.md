# Problem Scratch Pad

This file tracks active problems, debugging attempts, hypotheses, and solutions.

## Format Guidelines

For each problem:
1. **Problem Title** - Clear, descriptive name
2. **Description** - What's happening, error messages, symptoms
3. **Status** - `🔴 Active` | `🟡 Investigating` | `🟢 Resolved` | `⚪ On Hold`
4. **Attempts** - Chronological list of what's been tried
5. **Hypotheses** - Ideas to test
6. **Solution** - When resolved, document the fix

---

## Problem: Access Violation in ExecuteShield

**Status:** 🔴 Active  
**Date Started:** 2024-12-07

### Description
After fixing `AccountNotSigner`, pool initialization succeeds, but `ExecuteShield` fails with:
- "Access violation in stack frame 5 at address 0x200005f28 of size 8"
- Error occurs immediately after "Instruction: ExecuteShield" is logged
- No debug logs from `execute_shield` function are visible, suggesting error happens before first `msg!` call
- Program consumes ~8260 compute units before failing

### Attempts Made

1. ✅ **Added keep-alive for proof_vault_account_info** - Added `_keep_alive_proof_vault` variable
   - **Result:** ❌ Failed - Access violation persists
   - **Date:** 2024-12-07

2. ✅ **Added #[inline(never)] and debug logs** - Added `#[inline(never)]` to `execute_shield` and debug logs at entry point
   - **Result:** ❌ Failed - Access violation persists, debug logs not visible (error happens before our code runs)
   - **Date:** 2024-12-07
   - **Analysis:** Error occurs in Anchor's account validation before our function code executes

3. ✅ **Removed #[account(mut)] from system_program and rent** - These accounts are never writable, so mut attribute not needed
   - **Result:** ❌ Failed - Access violation persists
   - **Date:** 2024-12-07
   - **Analysis:** Removing `#[account(mut)]` from system_program and rent didn't help. The issue is not specific to those accounts.

4. ✅ **Added account existence verification** - Verify proof_vault, system_program, and rent exist before instruction
   - **Result:** ❌ Failed - Access violation persists, all accounts exist
   - **Date:** 2024-12-07
   - **Analysis:** All accounts exist, so missing accounts are not the cause. The error occurs at a specific address `0x200005f28` in stack frame 5, suggesting a stack overflow or corruption in Anchor's validation code.

5. ✅ **Removed all #[account(mut)] from ExecuteShield** - Removed mut from pool_state, commitment_tree, payer, and proof_vault
   - **Result:** Testing in progress
   - **Date:** 2024-12-07
   - **Hypothesis:** Multiple `#[account(mut)] UncheckedAccount` fields might cause Anchor to access account data for mutability validation, causing stack overflow. Removing mut attributes and handling mutability manually (accounts are still marked writable in instruction).

### Hypotheses

1. **Stack overflow in Anchor account validation** - The access violation happens before our code runs, possibly in Anchor's account validation
   - **Test:** Add `#[inline(never)]` to `execute_shield` function
   - **Priority:** High

2. **Stack corruption from unsafe transmute** - The `mem::transmute` operations might be corrupting the stack
   - **Test:** Review all `mem::transmute` usage in `execute_shield`
   - **Priority:** Medium

3. **Account validation issue** - The `validate_shield_basic_accounts` function might be accessing invalid memory
   - **Test:** Add debug logs to `validate_shield_basic_accounts` to see if it's reached
   - **Priority:** High

### Next Steps

1. ✅ Add `#[inline(never)]` to `execute_shield` - Done
2. ✅ Add debug logs at the very start of `execute_shield` - Done (logs not visible, error happens before our code)
3. ✅ Check for stack overflow warnings - Found warnings for `execute_unshield_core_impl`, but not for `execute_shield`
4. ✅ Investigate if Anchor accesses account data for `UncheckedAccount` with `#[account(mut)]` - Removed mut from system_program and rent, didn't help
5. ✅ Verify all accounts exist before instruction is called - All accounts exist, not the issue
6. ✅ Remove PDA constraint from pool_state - Changed to UncheckedAccount with manual validation, access violation persists
7. **CRITICAL HYPOTHESIS: The error occurs in Anchor's account struct validation, not PDA validation** - The consistent error at `0x200005f28` in stack frame 5 suggests Anchor is accessing a specific field or offset in the account struct during validation, causing a stack overflow. This might be a bug in Anchor's validation code when there are multiple UncheckedAccount fields.
8. **Consider using raw Solana instructions instead of Anchor's account validation** - This would bypass Anchor's validation entirely, but requires significant refactoring
9. **Check Anchor's GitHub issues for similar bugs** - Search for "access violation" or "stack frame" errors with UncheckedAccount
10. **Try reducing ExecuteShield to match ExecuteTransfer's pattern exactly** - ExecuteTransfer has only 4 accounts and works. Maybe we can restructure ExecuteShield to have fewer accounts in the struct.

---

## Problem: E2E Tests Failing with "Simulation failed"

**Status:** 🔴 Active  
**Date Started:** 2024-12-07

### Description
Most E2E tests are failing with generic "Simulation failed" errors without detailed error messages. Tests affected:
- Prepare + Execute Shield
- Prepare + Execute Unshield  
- Prepare + Execute Transfer
- Prepare + Execute TransferFrom
- Prepare + Execute BatchTransfer
- Prepare + Execute BatchTransferFrom
- Operation Expiry (operation not found in vault)

**Working:**
- Cleanup Expired Operations test passes
- Vault capacity test fails with expected space constraint error (account needs reallocation)

### Attempts Made

1. ✅ **Fixed depositId format** - Changed from `"timestamp-0"` to numeric format `(Date.now() + i).toString()`
   - **Result:** Fixed proof RPC error about BigInt conversion
   - **Date:** 2024-12-07

2. ✅ **Created factory initialization script** - `init-factory.ts` to manually initialize factory
   - **Result:** Factory successfully initialized
   - **Date:** 2024-12-07

3. ✅ **Fixed wSOL registration script** - Corrected rent sysvar and account ordering
   - **Result:** wSOL successfully registered
   - **Date:** 2024-12-07

4. ✅ **Deployed verifier program** - Synced program IDs and deployed
   - **Result:** Verifier program deployed successfully
   - **Date:** 2024-12-07

5. ✅ **Redeployed all programs** - Factory and pool programs after validator reset
   - **Result:** All programs deployed
   - **Date:** 2024-12-07

6. ✅ **Improved error logging** - Added detailed error logging to capture full transaction logs
   - **Result:** Now capturing transaction logs, transaction message, and signature
   - **Date:** 2024-12-07

7. ✅ **Identified root cause** - Vault program ID mismatch: deployed `9KZsNopijkAmER6EUWcfS3pKa8iTvZt7M7nMoU7nn1e3` but source declares `7Wr9XMjYfPm6HTN3ZV7r4wHnoV2zospvNN5A1xgoER8m`
   - **Result:** Error: `DeclaredProgramIdMismatch` in vault program
   - **Date:** 2024-12-07

8. ✅ **Fixed vault program ID** - Updated source code and Anchor.toml to match deployed ID
   - **Result:** Rebuilding and redeploying vault program
   - **Date:** 2024-12-07

9. ✅ **Fixed vault program ID in source** - Updated to `9KZsNopijkAmER6EUWcfS3pKa8iTvZt7M7nMoU7nn1e3` to match keypair
   - **Result:** Program rebuilt with correct ID. Validator needs restart to load new binary.
   - **Date:** 2024-12-07

10. ✅ **Aligned all program IDs** - Synced keys, updated SDK and startup script to use keypair IDs
   - **Result:** All program IDs now consistent. Validator restarted with correct program IDs.
   - **Date:** 2024-12-07
   - **Program IDs:**
     - Vault: `7Wr9XMjYfPm6HTN3ZV7r4wHnoV2zospvNN5A1xgoER8m` ✅ Loaded
     - Verifier: `2V5XN9rpubXdK3cdWBBjZwjxMpMzQBKTaN3moEJ59a8K` ✅ Loaded
     - Pool: `Av2D8ADegRt1zTfqEABidkcMH2zzusrDLwAeDFgfdQ1k` ❌ Not loading
     - Factory: `94XEJsvLbTNYit4mXowjhqkDpwqtnXnKs2KtF3PNW2oK` ⚠️ DeclaredProgramIdMismatch
   - **Current Issue:** Pool program not loading in validator. Factory has ID mismatch. Need to verify program binaries are correct.

11. ✅ **Deployed pool program** - Manually deployed pool program to validator
   - **Result:** Pool program now loaded and working. Tests progressing further.
   - **Date:** 2024-12-07
   - **Finding:** `--bpf-program` flag doesn't always load programs correctly. Manual deployment works.

12. ✅ **Fixed factory program ID** - Updated source to match keypair `94XEJsvLbTNYit4mXowjhqkDpwqtnXnKs2KtF3PNW2oK`
   - **Result:** Factory program rebuilt. Restarting validator to load new binary.
   - **Date:** 2024-12-07

13. ✅ **Rebuilt all programs** - Rebuilt all programs after `anchor clean` removed binaries
   - **Result:** All program binaries rebuilt. Restarting validator to load all programs.
   - **Date:** 2024-12-07

14. ✅ **Resolved program ID synchronization** - Aligned all program IDs to match keypair files
   - **Result:** All program IDs now consistent. Bootstrap succeeded! Factory initialized and wSOL registered.
   - **Date:** 2024-12-07
   - **Final Program IDs:**
     - Factory: `94XEJsvLbTNYit4mXowjhqkDpwqtnXnKs2KtF3PNW2oK` ✅
     - Vault: `7Wr9XMjYfPm6HTN3ZV7r4wHnoV2zospvNN5A1xgoER8m` ✅
     - Pool: `Av2D8ADegRt1zTfqEABidkcMH2zzusrDLwAeDFgfdQ1k` ✅
     - Verifier: `2V5XN9rpubXdK3cdWBBjZwjxMpMzQBKTaN3moEJ59a8K` ✅

15. ✅ **Fixed vault program pool ID mismatch** - Vault program had hardcoded old pool program ID
   - **Result:** Updated `PTF_POOL_PROGRAM_ID` in vault program from `ESbKkBQ9P7pavvFPejBXhguBY3BSLtf1LyEQqBNRDHqb` to `Av2D8ADegRt1zTfqEABidkcMH2zzusrDLwAeDFgfdQ1k`
   - **Date:** 2024-12-07
   - **Issue:** Vault initialization was failing with `InvalidPoolAuthority` because it was deriving pool authority using wrong program ID
   - **Fix:** Updated constant in `programs/vault/src/lib.rs` line 17
   - **Status:** Vault program rebuilt but can't be deployed because old program has system program as authority (immutable). Need to work around this.

16. ✅ **Fixed OriginMintMismatch** - Pool program was using old factory program ID
   - **Result:** Rebuilt pool program with correct factory dependency, now expects correct mint mapping `2PVRchPKgaH3LkBJP9uuQNSZRQ4DTDJmerF7bruCABVM`
   - **Date:** 2024-12-07
   - **Fix:** Rebuilt pool program after factory program ID was updated

17. ✅ **Fixed TwinMintMismatch** - SDK was including placeholder for optional twin_mint account
   - **Result:** Updated SDK to skip optional accounts entirely (matching bootstrap script behavior)
   - **Date:** 2024-12-07
   - **Fix:** Changed `buildInitializePoolInstruction` to skip optional accounts when not provided, instead of including placeholders

18. ✅ **AccountNotSigner error for payer** - RESOLVED by accepting placeholder accounts
   - **Result:** ✅ RESOLVED - Pool initialization now succeeds
   - **Date:** 2024-12-07
   - **Solution:** Modified program to accept placeholder accounts (SystemProgram.programId or payer's account) for optional `twin_mint` when `has_ptkn` is false. This preserves account positions while treating the placeholder as `None` functionally.
   - **Changes Made:**
     1. Modified `programs/pool/src/lib.rs` to accept placeholder accounts in `initialize_pool` when `has_ptkn` is false
     2. Modified `web/app/lib/sdk.ts` to include placeholder for optional `twin_mint` account (using payer's account for writable accounts)
     3. Fixed factory program ID mismatch - updated SDK and bootstrap script to use `2vYEqzgPNSxGxnQCEGqJb8vqZKSs2h183NtzCzW1i4LW`
     4. Redeployed factory program and re-registered wSOL
   - **Current Status:** Pool initialization succeeds. New issue: "Access violation in stack frame 5" during `ExecuteShield` (separate issue, not related to AccountNotSigner)

### Hypotheses

1. **Transaction simulation is failing silently** - The error messages aren't being captured properly
   - **Test:** Add detailed error logging to test script to capture full transaction logs
   - **Priority:** High

2. **Account derivation mismatch** - PDAs might be derived incorrectly
   - **Test:** Verify all PDA derivations match between SDK and program
   - **Priority:** Medium

3. **Program ID mismatch** - Some program IDs might not match between SDK and deployed programs
   - **Test:** Verify all program IDs in `programIds.ts` match deployed programs
   - **Priority:** High

4. **Missing account initialization** - Some accounts might not be initialized before use
   - **Test:** Check if pool/vault accounts are initialized before shield operations
   - **Priority:** Medium

5. **Transaction size/compute limits** - Transactions might be hitting limits
   - **Test:** Check compute units and transaction size
   - **Priority:** Low

6. **Account ordering** - Account order in instructions might be incorrect
   - **Test:** Verify account order matches IDL exactly
   - **Priority:** Medium

### Next Steps

1. **Capture detailed error logs** - Modify test script to log full transaction simulation errors
2. **Verify program IDs** - Check all program IDs match between SDK and deployed programs
3. **Check account derivations** - Verify PDA derivations are correct
4. **Test with verbose logging** - Enable verbose logging in SDK to see what's happening

### Related Files
- `web/app/scripts/test-prepare-execute.ts` - Test script
- `web/app/lib/sdk.ts` - SDK functions
- `web/app/lib/onchain/programIds.ts` - Program IDs

---

## Problem: Vault Capacity Test Fails with Space Constraint

**Status:** 🟡 Investigating  
**Date Started:** 2024-12-07

### Description
Vault capacity test fails when trying to add more than 3 operations. Error:
```
Error Code: ConstraintSpace. Error Number: 2019. Error Message: A space constraint was violated.
Left: 2069
Right: 3069
```

This is **expected behavior** - the vault account needs to be reallocated as more operations are added.

### Attempts Made

1. ⚠️ **Identified as expected behavior** - Vault account needs reallocation
   - **Result:** This is not a bug, but needs handling in the test
   - **Date:** 2024-12-07

### Hypotheses

1. **Vault account needs reallocation** - Account space must be increased before adding more operations
   - **Test:** Add reallocation logic to test before adding operations beyond capacity
   - **Priority:** Medium

2. **Test should handle reallocation** - The test should reallocate the vault account when needed
   - **Test:** Modify test to reallocate vault account when space constraint is hit
   - **Priority:** Low (this is expected behavior)

### Next Steps

1. **Document expected behavior** - This is not a bug, vault needs reallocation
2. **Update test** - Modify test to handle reallocation or skip this test case
3. **Add reallocation helper** - Create helper function to reallocate vault account

---

## Problem: Operation Not Found in Vault

**Status:** 🔴 Active  
**Date Started:** 2024-12-07

### Description
Operation Expiry test shows "Operation not found in vault" after preparing a shield operation.

### Attempts Made

1. ⚠️ **Identified in test output** - Operation prepared but not found in vault
   - **Result:** Need to investigate why operation isn't being stored
   - **Date:** 2024-12-07

### Hypotheses

1. **Operation not being stored** - `prepare_shield` might not be storing the operation correctly
   - **Test:** Check if `prepare_shield` is actually storing the operation in the vault
   - **Priority:** High

2. **Vault account not initialized** - Vault account might not be initialized before storing operations
   - **Test:** Verify vault account is initialized before prepare_shield
   - **Priority:** High

3. **Account derivation mismatch** - Vault PDA might be derived incorrectly
   - **Test:** Verify vault PDA derivation matches between prepare and query
   - **Priority:** Medium

### Next Steps

1. **Check prepare_shield implementation** - Verify operation is being stored
2. **Verify vault initialization** - Ensure vault is initialized before operations
3. **Check PDA derivation** - Verify vault PDA is correct

---

## Resolved Problems

### Problem: Bootstrap Script ProgramAccountNotFound Error
**Status:** 🟢 Resolved  
**Date Resolved:** 2024-12-07

**Solution:** Manually initialized factory using `init-factory.ts` script, then registered wSOL using `register-wsol.ts`. All programs were redeployed after validator reset.

---

## Notes

- Always update this file when working on problems
- Add new attempts immediately after trying them
- Mark hypotheses as tested when verified
- Move resolved problems to "Resolved Problems" section

