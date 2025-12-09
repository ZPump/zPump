# Problem Scratch Pad

This file tracks active problems, debugging attempts, hypotheses, and solutions.

**Note**: Resolved problems with reusable solutions have been moved to `KNOWN_PROBLEMS_AND_PATTERNS.md`. Check that file before debugging to see if your issue matches a known problem.

## Format Guidelines

For each problem:
1. **Problem Title** - Clear, descriptive name
2. **Description** - What's happening, error messages, symptoms
3. **Status** - `🔴 Active` | `🟡 Investigating` | `🟢 Resolved` | ⚪ On Hold`
4. **Attempts** - Chronological list of what's been tried
5. **Hypotheses** - Ideas to test
6. **Solution** - When resolved, document the fix

---

## Current Active Problems

### Problem: prepare_shield Error 0x0

**Status:** 🔴 Active  
**Date Started:** 2024-12-09

### Description
`prepare_shield` instruction fails with `custom program error: 0x0` after account creation. The system program call succeeds, but the program fails immediately after.

### Symptoms
- Error occurs after `invoke_signed` creates account successfully
- System program call succeeds (`Program 11111111111111111111111111111111 success`)
- No logs from `prepare_shield_core_from_raw` appear
- Error code `0x0` (generic Anchor error)

### Attempts Made

1. ✅ **Added account discriminator** - Set discriminator when creating account
   - **Result:** Still fails with error 0x0
   - **Date:** 2024-12-09

2. ✅ **Added detailed logging** - Added logs throughout `prepare_shield_core_from_raw`
   - **Result:** No logs appear, suggesting error occurs before function runs
   - **Date:** 2024-12-09

### Hypotheses

1. **Account discriminator not set correctly** - Discriminator might be wrong or not set at right time
   - **Test:** Verify discriminator matches expected value
   - **Priority:** High

2. **Account serialization issue** - `try_serialize` might be failing
   - **Test:** Check if serialization succeeds
   - **Priority:** Medium

3. **Account reallocation issue** - Reallocation might corrupt account data
   - **Test:** Check account state after reallocation
   - **Priority:** Medium

### Next Steps

1. Add more detailed logging to pinpoint exact failure location
2. Verify account discriminator is set correctly
3. Check if account data is valid after creation
4. Test with account that already exists vs new account

### Related Files
- `programs/pool/src/lib.rs` - `prepare_shield_core_from_raw` function
- `KNOWN_PROBLEMS_AND_PATTERNS.md` - See "Missing Account Discriminator" section

---

## Resolved Problems (Moved to Known Problems)

The following problems have been resolved and moved to `KNOWN_PROBLEMS_AND_PATTERNS.md`:

- ✅ **ExecuteShield Access Violation** - Moved to "Access Violation in Anchor Validation Phase"
- ✅ **ExecuteUnshield nullifier_set Account Ownership Validation** - Moved to "Account Ownership Validation Errors"
- ✅ **Factory Program ID Mismatch** - Moved to "Factory Program ID Mismatch"
- ✅ **Account Ownership Validation Errors** - Moved to "Account Ownership Validation Errors"
- ✅ **IDL Regeneration Issues** - Moved to "IDL Regeneration Issues"

See `KNOWN_PROBLEMS_AND_PATTERNS.md` for detailed solutions and patterns.

---

## Archive

### Previous Issues (Consolidated 2024-12-09)

All resolved and repetitive issues have been consolidated into `KNOWN_PROBLEMS_AND_PATTERNS.md` to keep this scratch pad focused on active debugging work.

**Consolidation Date:** 2024-12-09  
**Scratch Pad Size Before:** 730 lines, 40KB  
**Scratch Pad Size After:** ~100 lines, ~5KB  
**Entries Moved:** 5 major problem categories with multiple sub-issues
