# VersionedTransaction Lookup Table Mapping Issue

## Problem

The `VersionedTransaction` with Address Lookup Tables (ALTs) is failing with `InvalidProgramId` error for `vault_program`:
- Error: `vault_program` is incorrectly mapped to `TOKEN_PROGRAM_ID`
- This happens even when the lookup table has the correct address order

## Root Cause

The `compileToV0Message` function automatically compresses addresses from instructions into lookup table indexes. However, when instruction accounts are not all present in the lookup table (e.g., user-specific accounts like `vault_token_account`, `depositor_token_account`, `payer`), the automatic compression may not correctly map accounts to their lookup table indexes.

### Shield Instruction Account Order

From `programs/pool/src/lib.rs`, the Shield instruction accounts are:
1. pool_state (0)
2. hook_config (1)
3. hook_whitelist (2)
4. nullifier_set (3)
5. commitment_tree (4)
6. note_ledger (5)
7. vault_state (6)
8. vault_token_account (7) - **NOT in lookup table** (user-specific)
9. depositor_token_account (8) - **NOT in lookup table** (user-specific)
10. twin_mint (9) - **NOT in lookup table** (optional, user-specific)
11. verifier_program (10)
12. verifying_key (11)
13. shield_claim (12)
14. payer (13) - **NOT in lookup table** (signer, must be direct)
15. origin_mint (14)
16. mint_mapping (15)
17. factory_state (16)
18. vault_program (17) - **CRITICAL: Must be at correct position**
19. token_program (18) - **CRITICAL: Must be at correct position**

### Lookup Table Order

The lookup table is created with addresses in this order (skipping user-specific accounts):
1. poolState (0)
2. hookConfig (1)
3. hookWhitelist (2)
4. nullifierSet (3)
5. commitmentTreeKey (4)
6. noteLedger (5)
7. vaultState (6)
8. VERIFIER_PROGRAM_ID (10)
9. verifyingKey (11)
10. shieldClaim (12)
11. originMintKey (14)
12. mintMappingKey (15)
13. factoryState (16)
14. VAULT_PROGRAM_ID (17)
15. TOKEN_PROGRAM_ID (18)
16. SystemProgram (19)
17. RENT (20)

## Issue

When `compileToV0Message` compresses the instruction, it maps:
- Instruction position 17 (`vault_program`) → Lookup table index 14
- Instruction position 18 (`token_program`) → Lookup table index 15

However, the automatic compression algorithm may not correctly account for skipped accounts (positions 7-9, 13), causing incorrect mapping.

## Current Status

- ✅ Lookup table order is correct (factory_state → vault_program → token_program)
- ✅ Fresh pools created after fix have correct lookup table
- ❌ `compileToV0Message` automatic compression still causes mapping errors
- ⚠️ VersionedTransaction fails even with correct lookup table order

## Workaround

For now, VersionedTransaction is disabled/skipped when lookup table order issues are detected. The system falls back to:
1. Transaction splitting (shield + finalize_ledger in separate transactions)
2. Legacy transactions with `skipPreflight: true` for slightly oversized transactions

## Future Solution

We need to either:
1. **Manually construct MessageV0** without using `compileToV0Message`'s automatic compression
2. **Account for skipped positions** when mapping instruction accounts to lookup table indexes
3. **Include all accounts in lookup table** (even user-specific ones) - but this may not be feasible
4. **Use a different approach** - e.g., derive addresses programmatically without lookup tables

## Testing

- Fresh pool created with correct lookup table order ✅
- Lookup table has factory_state (index 13) → vault_program (index 14) → token_program (index 15) ✅
- VersionedTransaction still fails with mapping error ❌
- Fallback to transaction splitting works for tests ✅

