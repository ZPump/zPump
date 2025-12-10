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

### Problem: execute_shield_v2 AccountDataTooShort Error (0x19)

**Status:** 🔴 Active  
**Date Started:** 2024-12-09

### Description
`execute_shield_v2` instruction fails with `custom program error: 0x19` (AccountDataTooShort) when trying to deserialize the `UserProofVault` account using `Account::try_from`. The discriminator is correct (`[130, 2, 224, 154, 38, 129, 158, 160]`), but deserialization fails with "AccountDidNotDeserialize" error.

### Symptoms
- Error occurs at `Account::try_from` for `proof_vault` account in `execute_shield_v2_core_from_raw`
- Discriminator is correct (matches expected `UserProofVault` discriminator)
- Account data length is 10069 bytes (reasonable size)
- Account owner is correct (`guKkNcvnhiKPPK9e2qwYWWPZWdLfk78QwFcVEL4hAbu`)
- Error: `AnchorError { error_name: "AccountDidNotDeserialize", error_code_number: 3003 }`
- Bytes 8-15 show the discriminator repeated (might be a logging artifact)

### Attempts Made

1. ✅ **Tried Account::try_from** - Used standard Anchor deserialization (like other functions)
   - **Result:** Failed with "AccountDidNotDeserialize"
   - **Date:** 2024-12-09

2. ✅ **Tried manual deserialization with try_from_slice** - Manually deserialized using `UserProofVault::try_from_slice`
   - **Result:** Failed with "Unexpected variant index: 138" (enum deserialization error)
   - **Date:** 2024-12-09

3. ✅ **Added detailed logging** - Logged discriminator, first 20 bytes, and bytes 8-100
   - **Result:** Discriminator is correct, but deserialization still fails
   - **Date:** 2024-12-09

### Hypotheses

1. **Account data structure mismatch** - The account might have been created with a different version of the struct or corrupted
   - **Test:** Check how `prepare_shield` creates the account and verify the serialization format
   - **Priority:** High

2. **Vec<PreparedOperation> deserialization issue** - The `Vec` field might not be deserializing correctly
   - **Test:** Try deserializing the account manually, field by field
   - **Priority:** Medium

3. **Account created incorrectly** - `prepare_shield` might not be creating the account correctly
   - **Test:** Verify `prepare_shield` is creating the account with the correct structure
   - **Priority:** High

### Next Steps

1. Check how `prepare_shield` creates the account (via `init_if_needed` or manual creation)
2. Verify the account structure matches what Anchor expects
3. Try deserializing the account manually, field by field, to identify which field is causing the issue
4. Check if there's a version mismatch between how the account was created and how it's being deserialized

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
