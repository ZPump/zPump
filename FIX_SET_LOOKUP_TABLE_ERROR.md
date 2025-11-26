# Fix set_lookup_table Instruction Error 3005

## Problem Summary

The `set_lookup_table` instruction in the factory program is failing with error code 3005 (0x0BBD in hex). This error is not a standard Anchor error code and appears to be occurring during account validation or constraint checking.

## Context

We are implementing a migration to store Address Lookup Table addresses directly in the `MintMapping` account on-chain for O(1) scalability. The `set_lookup_table` instruction is responsible for:
1. Validating the lookup table account (ownership, size, active status)
2. Resizing existing `MintMapping` accounts from 85 bytes (old format) to 118 bytes (new format with `lookup_table` field)
3. Writing the lookup table address to the `lookup_table` field in the `MintMapping` account

## Current Implementation

### Rust Program (`programs/factory/src/lib.rs`)

The `set_lookup_table` instruction:
- Validates factory state is not paused
- Validates authority matches factory state authority
- Validates lookup table account (ownership by AddressLookupTableProgram, minimum size, active status)
- Validates `mint_mapping` PDA matches `origin_mint` (manual validation since we use `UncheckedAccount`)
- Resizes account if needed (85 → 118 bytes) with rent transfer
- Writes `lookup_table` field directly at offset 85 in account data

### Accounts Struct

```rust
#[derive(Accounts)]
pub struct SetLookupTable<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    /// CHECK: Validated manually in instruction - PDA derived from origin_mint
    #[account(mut)]
    pub mint_mapping: UncheckedAccount<'info>,
    /// CHECK: Used to derive and validate mint_mapping PDA
    pub origin_mint: UncheckedAccount<'info>,
    /// CHECK: Validated in instruction to be a valid, active address lookup table
    pub lookup_table: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
```

### SDK Implementation (`web/app/lib/sdk.ts`)

The `setLookupTableForMint` function creates a transaction with accounts in this order:
1. `factoryState` (writable)
2. `wallet.publicKey` (signer, writable)
3. `mintMapping` (writable)
4. `originMint` (read-only)
5. `lookupTable` (read-only)
6. `SystemProgram.programId` (read-only)

## Error Details

- **Error Code**: 3005 (0x0BBD in hex)
- **Error Type**: `{"InstructionError":[0,{"Custom":3005}]}`
- **Occurrence**: During `set_lookup_table` instruction execution
- **Note**: Error 3005 is NOT a standard Anchor error code (which start at 6000/0x1770)

## What We've Tried

1. ✅ Added `system_program` to accounts struct (for rent transfers)
2. ✅ Updated IDL to match current code structure
3. ✅ Changed `mint_mapping` from `Account<'info, MintMapping>` to `UncheckedAccount<'info>` to avoid deserialization issues with old-size accounts
4. ✅ Added manual PDA validation (since we can't use Anchor's automatic validation with `UncheckedAccount`)
5. ✅ Simplified account resizing logic
6. ✅ Changed from full deserialization/serialization to direct field writing
7. ✅ Added zero-initialization of newly allocated bytes after resizing
8. ✅ Verified account order matches IDL expectations

## Current Code Location

- **Rust Program**: `programs/factory/src/lib.rs` - `set_lookup_table` function (line ~291)
- **Accounts Struct**: `programs/factory/src/lib.rs` - `SetLookupTable` struct (line ~1543)
- **SDK Function**: `web/app/lib/sdk.ts` - `setLookupTableForMint` function (line ~548)
- **Test**: `web/app/scripts/lowlevel-e2e.ts` - calls `setLookupTableForMint` (line ~980)

## Key Constraints

1. **Backward Compatibility**: Must handle existing `MintMapping` accounts that are 85 bytes (created before migration)
2. **Account Resizing**: Must resize accounts from 85 to 118 bytes, transferring additional rent
3. **PDA Validation**: Must manually validate `mint_mapping` PDA since we use `UncheckedAccount`
4. **Field Layout**: `lookup_table` field is `Option<Pubkey>` (33 bytes: 1 byte discriminator + 32 bytes Pubkey) at offset 85

## MintMapping Structure

```rust
#[account]
pub struct MintMapping {
    pub origin_mint: Pubkey,           // 32 bytes (offset 8)
    pub ptkn_mint: Pubkey,             // 32 bytes (offset 40)
    pub has_ptkn: bool,                // 1 byte (offset 72)
    pub status: u8,                   // 1 byte (offset 73)
    pub decimals: u8,                 // 1 byte (offset 74)
    pub features: FeatureFlags,        // 1 byte (offset 75)
    pub fee_bps_override: u16,        // 2 bytes (offset 76)
    pub has_fee_override: bool,        // 1 byte (offset 78)
    pub bump: u8,                     // 1 byte (offset 79)
    pub is_native_ztoken: bool,        // 1 byte (offset 80)
    pub lookup_table: Option<Pubkey>,  // 33 bytes (offset 85) - NEW FIELD
}
// Total: 8 (discriminator) + 85 + 33 = 126 bytes
// But SPACE constant is 118 (8 + 85 + 33 - 4 padding removed)
```

## Hypothesis

The error 3005 might be:
1. An Anchor constraint validation error (but not a standard error code)
2. An issue with account resizing (`realloc`) when account is not properly initialized
3. A problem with manual PDA validation conflicting with Anchor's internal checks
4. An issue with account mutability or writability constraints

## What Needs to Be Fixed

1. **Identify the root cause** of error 3005
2. **Fix the instruction** so it executes successfully
3. **Ensure backward compatibility** with 85-byte accounts
4. **Verify the fix** by running the test suite: `./scripts/run-full-test-suite.sh`

## Test Command

```bash
cd /home/hendo420/zPump
./scripts/run-full-test-suite.sh
```

The test will fail at the "Low-Level E2E" section when trying to call `set_lookup_table`.

## Additional Debugging Information

- Transaction logs are being captured in the test script but may not show program logs
- The error occurs immediately when the instruction is executed
- All Anchor tests pass (the issue is only in the E2E test)
- The factory program builds successfully without errors

## Success Criteria

The fix is successful when:
1. `set_lookup_table` instruction executes without errors
2. The lookup table address is correctly stored in the `MintMapping` account
3. The test suite passes: `./scripts/run-full-test-suite.sh`
4. Both old (85-byte) and new (118-byte) `MintMapping` accounts are handled correctly

## Update: Current Error Status

**Current Error**: The instruction now panics with `"Illegal base58 char"` at `src/lib.rs:12:40`. This is a runtime panic, not a constraint error.

**Error Details**:
- Error Type: `ProgramFailedToComplete` with panic message
- Panic Location: `src/lib.rs:12:40` (this is line 12 in the imports, suggesting it's in Anchor's internal code)
- Panic Message: `"Illegal base58 char"`
- Note: Line 12 in `programs/factory/src/lib.rs` is: `use spl_token_2022::state::Mint as Token2022Mint;`

**What We've Tried**:
1. ✅ Fixed account order (added `origin_mint` and `system_program` to instruction) - PR merged
2. ❌ Removed `emit!` call - panic still occurs
3. ❌ Simplified PDA validation (commented out) - panic still occurs
4. ❌ Simplified lookup table deserialization (commented out) - panic still occurs
5. ❌ Changed `realloc` to use zero-init (`true` instead of `false`) - panic still occurs
6. ❌ Added validation for account initialization before resizing - panic still occurs

**Hypothesis**:
The panic appears to be occurring in Anchor's internal account validation or error formatting code, possibly when:
- Anchor tries to format a `Pubkey` for error messages
- Anchor validates `UncheckedAccount` constraints
- Anchor processes the `has_one = authority` constraint on `factory_state`
- Anchor's internal logging tries to format account keys

**Potential Solutions to Try**:
1. Check if the panic occurs before our instruction code runs (in Anchor's account validation)
2. Try using `Account<'info, MintMapping>` instead of `UncheckedAccount` and handle the size mismatch differently
3. Check Anchor version compatibility - may need to update or use different Anchor features
4. Try removing the `has_one = authority` constraint and validate manually
5. Check if there's an issue with how we're accessing `ctx.accounts.origin_mint.key()` or other account keys
6. Look for any `msg!` or debug logging that might be trying to format pubkeys
7. Check if the issue is with the account order in the IDL vs actual instruction

**Current Code State**:
- Account resizing logic is in place
- Lookup table field writing is simplified (direct byte manipulation)
- PDA validation is commented out (for debugging)
- Lookup table deserialization is simplified (for debugging)
- Event emission is commented out (for debugging)
- Panic still occurs, suggesting it's in Anchor's pre-instruction validation

**Next Steps**:
1. Investigate Anchor's account validation for `UncheckedAccount` with manual constraints
2. Check if the panic occurs in `Context<SetLookupTable>` initialization
3. Try a minimal instruction that only resizes the account to isolate the issue
4. Check Anchor version and known issues with account resizing

