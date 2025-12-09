# Known Problems and Patterns to Avoid

This file documents repetitive bugs, common pitfalls, and patterns to avoid based on past debugging experiences. Use this as a reference to prevent repeating known issues.

## How to Use This File

- **Before debugging**: Check this file to see if the issue matches a known problem
- **When encountering a new pattern**: Add it here if it's likely to recur
- **When fixing issues**: Update patterns with solutions that worked
- **During code reviews**: Reference this file to catch common mistakes

---

## Anchor Framework Issues

### Access Violation in Anchor Validation Phase

**Problem**: Access violation errors (e.g., `0x200005xxx`) occurring in Anchor's `try_accounts` validation BEFORE function code runs.

**Symptoms**:
- Error occurs at addresses like `0x200005c28`, `0x200005a78`, `0x200005440`
- No function logs appear (error happens before `msg!()` calls)
- Low compute unit usage (~7000-8000) indicating early failure
- Error persists even with minimal structs (4 accounts or less)

**Known Causes**:
- Stack overflow during Anchor's validation phase (exceeding 4KB stack limit)
- Too many accounts in `#[derive(Accounts)]` struct (10+ accounts)
- Complex PDA derivations causing stack overflow
- Account ownership checks failing due to Anchor's validation phase bugs

**Solutions**:
- ✅ Use raw instruction pattern with minimal struct (`_phantom: UncheckedAccount<'info>`)
- ✅ Extract accounts manually from `remaining_accounts` in function body
- ✅ Use `PoolAddresses::derive_all()` to centralize PDA derivation and reduce stack usage
- ✅ Bypass Anchor validation entirely by removing `#[program]` macro and using custom entrypoint

**Files Using This Pattern**:
- `programs/pool/src/lib.rs` - `execute_shield_v2`, `execute_unshield`, `execute_transfer`, `execute_transfer_from`, `approve_allowance`, `execute_batch_transfer`, `execute_batch_transfer_from`, `prepare_shield`, `initialize_pool`

**References**:
- See `.cursor/rules/anchor-raw-instruction-workaround.mdc` for detailed implementation
- See `docs/development/anchor-access-violation-workaround.md` for full documentation

---

### Account Ownership Validation Errors

**Problem**: `AccountOwnedByWrongProgram` or `InvalidAccountOwner` errors when accounts are owned by the correct program.

**Symptoms**:
- Error code `0x1770` (6000 = `CommonError::InvalidAccountOwner`)
- Account exists and is owned by expected program (verified via `solana account`)
- Error occurs in `AccountValidator::validate_ownership`

**Known Causes**:
- `require_keys_eq!` macro in `validate_ownership` comparing `*account.owner` vs `*expected_owner` with type mismatches
- AccountInfo lifetime issues when using `unsafe { mem::transmute }`
- Account not properly initialized (discriminator not set)

**Solutions**:
- ✅ Bypass `AccountValidator::validate_ownership` and do manual validation:
  ```rust
  if *account.owner != expected_owner {
      return Err(ProgramError::Custom(InvalidAccountOwner as u32));
  }
  if account.data_len() < 8 {
      return Err(ProgramError::Custom(AccountDataTooShort as u32));
  }
  ```
- ✅ Set account discriminator when creating accounts manually
- ✅ Verify account exists and owner matches before validation

**Example**:
- `initialize_pool_core_from_raw` - Manual validation for `mint_mapping` and `factory_state`

---

### IDL Regeneration Issues

**Problem**: IDL not updating after struct changes, or `anchor build` failing to regenerate IDL.

**Known Causes**:
- `anchor build` failing due to compilation errors in other programs
- IDL cached and not regenerated
- Manual IDL edits not being overwritten

**Solutions**:
- ✅ Manually edit IDL when `anchor build` fails
- ✅ Remove IDL file and rebuild to force regeneration
- ✅ Verify IDL account count matches struct account count
- ✅ Check IDL after each struct change

**Example**:
- `ExecuteUnshield` - Manually removed `nullifier_set` from IDL (21 accounts -> 20 accounts)

---

## Account Initialization Issues

### Missing Account Discriminator

**Problem**: Error `0x0` (generic Anchor error) when trying to deserialize accounts created manually.

**Symptoms**:
- Account created successfully via `invoke_signed`
- Account data serialized correctly
- Error occurs when Anchor tries to deserialize account
- No specific error message, just `custom program error: 0x0`

**Known Causes**:
- Account discriminator (first 8 bytes) not set when creating account
- Discriminator not set after account reallocation
- Discriminator computed incorrectly

**Solutions**:
- ✅ Always set discriminator when creating accounts:
  ```rust
  let discriminator_hash = hashv(&[b"account:AccountName"]);
  let discriminator = &discriminator_hash.to_bytes()[0..8];
  account_data[0..8].copy_from_slice(discriminator);
  ```
- ✅ Set discriminator after reallocation
- ✅ Verify discriminator matches expected value before deserialization

**Example**:
- `prepare_shield_core_from_raw` - Set discriminator when creating `UserProofVault` account

---

### Account Reallocation Issues

**Problem**: Account reallocation fails or account data becomes corrupted.

**Known Causes**:
- Discriminator not preserved during reallocation
- Account data not properly initialized after reallocation
- Reallocation happening in wrong order

**Solutions**:
- ✅ Set discriminator after reallocation
- ✅ Initialize account data after reallocation
- ✅ Verify account size before and after reallocation

---

## Program ID Mismatches

### Factory Program ID Mismatch

**Problem**: PDA derivations fail because factory program ID in source doesn't match deployed ID.

**Symptoms**:
- `OriginMintMismatch` errors
- PDA derivations produce different addresses than expected
- SDK and program derive different addresses for same inputs

**Known Causes**:
- Factory program `declare_id!` doesn't match deployed program ID
- SDK uses different factory program ID than program
- Program rebuilt but not redeployed

**Solutions**:
- ✅ Verify `declare_id!` matches deployed program ID
- ✅ Update SDK `FACTORY_PROGRAM_ID` to match deployed ID
- ✅ Rebuild and redeploy factory program after ID changes
- ✅ Rebuild pool program after factory program ID changes

**Example**:
- Factory program declared `GQhkApwhBSy65JGFNpKBfFSNkhxjuJG5g8oY2DQhDN5P` but SDK used `94XEJsvLbTNYit4mXowjhqkDpwqtnXnKs2KtF3PNW2oK`
- Fixed by updating factory program `declare_id!` to match SDK

---

## Stack Overflow Issues

### Stack Overflow in Account Validation

**Problem**: Stack overflow errors when validating many accounts or complex PDAs.

**Known Causes**:
- Too many `Pubkey::find_program_address` calls in single function
- Large structs with many accounts
- Complex PDA derivation logic

**Solutions**:
- ✅ Use `PoolAddresses::derive_all()` to centralize PDA derivation
- ✅ Box large structs: `Box::new(PoolAddresses::derive_all(...))`
- ✅ Use `#[inline(never)]` on large functions to prevent inlining
- ✅ Extract PDA derivation to separate function

**Example**:
- `initialize_pool_core_from_raw` - Uses `PoolAddresses::derive_all()` instead of individual `find_program_address` calls

---

## Lifetime and Type Issues

### AccountInfo Lifetime Issues

**Problem**: Borrow checker errors when working with `AccountInfo` from `remaining_accounts`.

**Known Causes**:
- `AccountInfo` lifetimes don't match function requirements
- Trying to create `Account` from `AccountInfo` with wrong lifetimes
- Multiple mutable borrows of same account

**Solutions**:
- ✅ Use `unsafe { mem::transmute }` to extend lifetimes to `'static`:
  ```rust
  let account_static: &'static AccountInfo<'static> = unsafe { mem::transmute(account) };
  ```
- ✅ Extract data before creating typed wrappers
- ✅ Drop borrows before reusing accounts

**Example**:
- All `_core_from_raw` functions use `mem::transmute` for lifetime extension

---

### Pubkey Type Mismatches

**Problem**: Type errors when comparing `Pubkey` vs `&Pubkey`.

**Known Causes**:
- `require_keys_eq!` expects `&Pubkey` for both arguments
- `account.key()` returns `&Pubkey` but comparisons need `Pubkey`
- Direct comparison of `Pubkey` with `&Pubkey`

**Solutions**:
- ✅ Clone `Pubkey` when needed: `account.key().clone()`
- ✅ Compare `&Pubkey` with `Pubkey` directly (Rust allows this)
- ✅ Use `*account.owner` to dereference when comparing

**Example**:
- `initialize_pool_core_from_raw` - Manual validation uses `*account.owner != expected_owner`

---

## Testing and Deployment Issues

### Program Not Updating After Deployment

**Problem**: Program deployed but logs don't reflect code changes.

**Known Causes**:
- Program binary cached by validator
- Wrong program ID used in deployment
- Program not actually deployed (deployment failed silently)

**Solutions**:
- ✅ Verify deployment signature
- ✅ Check program ID matches `declare_id!`
- ✅ Restart validator if needed
- ✅ Verify program binary size changed

---

### Test Failures Due to Stale State

**Problem**: Tests fail because on-chain state doesn't match expected state.

**Known Causes**:
- Accounts not initialized
- Program state from previous test runs
- Accounts created with wrong parameters

**Solutions**:
- ✅ Use fresh keypairs for each test
- ✅ Initialize accounts before use
- ✅ Clean up test state between runs
- ✅ Verify account state before assertions

---

## Patterns to Use

### Centralized PDA Derivation

**Pattern**: Use `PoolAddresses::derive_all()` instead of individual `find_program_address` calls.

**Why**: Reduces stack usage and centralizes derivation logic.

**Example**:
```rust
let pool_addresses = Box::new(ptf_common::addresses::PoolAddresses::derive_all(
    &origin_mint_key,
    program_id,
));
```

**Files Using This**:
- `execute_shield_v2_core_from_raw`
- `execute_unshield_core_from_raw`
- `initialize_pool_core_from_raw`

---

### Manual Account Validation

**Pattern**: Bypass `AccountValidator::validate_ownership` and do manual validation.

**Why**: Avoids type/lifetime issues and provides better error messages.

**Example**:
```rust
if *account.owner != expected_owner {
    return Err(ProgramError::Custom(InvalidAccountOwner as u32));
}
if account.data_len() < 8 {
    return Err(ProgramError::Custom(AccountDataTooShort as u32));
}
```

---

### Raw Instruction Pattern

**Pattern**: Use minimal struct with `_phantom: UncheckedAccount<'info>` and extract accounts manually.

**Why**: Bypasses Anchor's validation phase that causes access violations.

**Example**:
```rust
#[derive(Accounts)]
pub struct ExecuteShieldRaw<'info> {
    pub _phantom: UncheckedAccount<'info>,
}

pub fn execute_shield_v2(ctx: Context<ExecuteShieldRaw>, ...) -> Result<()> {
    // Extract accounts from ctx.remaining_accounts
    // Manual validation and extraction
}
```

**See**: `.cursor/rules/anchor-raw-instruction-workaround.mdc` for full pattern

---

## Last Updated

**Date**: 2024-12-09  
**Maintained By**: Development Team  
**Review Frequency**: After each major debugging session

