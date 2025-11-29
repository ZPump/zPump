# Solution 1 Implementation - Unified Lifetime Scope

## Problem
Accessing `ctx.remaining_accounts` creates a lifetime scope that conflicts with accessing `ctx.accounts` later, even sequentially.

## Root Cause
Even extracting `remaining_accounts = ctx.remaining_accounts` creates a lifetime conflict because:
- `ctx.remaining_accounts` has lifetime parameter '1 from Context
- `ctx.accounts` has lifetime parameter '2 from Context
- Rust sees these as incompatible even when used sequentially

## Solution 1 Implementation Status

### ✅ Completed:
1. **SDK Updated**: Added payer, system_program, rent to remaining_accounts
   - Location: `web/app/lib/sdk.ts` line ~3491
   - These accounts are now at the end of remaining_accounts array

2. **Parsing Function Created**: `parse_cpi_common_accounts`
   - Location: `programs/dex/src/ztoken_cpi.rs` line ~638
   - Extracts payer, system_program, rent from remaining_accounts (last 3 accounts)

3. **Instruction Handler Updated**: All accounts from remaining_accounts
   - Location: `programs/dex/src/instructions/add_liquidity.rs`
   - Updated to use parse_cpi_common_accounts instead of ctx.accounts

### ❌ Still Failing:
- **Lifetime conflict persists** when calling `parse_ztoken_accounts(ctx.remaining_accounts, ...)`
- Error: `lifetime may not live long enough` at line 157
- Rust sees lifetime parameter conflicts even though all accounts come from remaining_accounts

## Why This Is Still Failing

The issue is that **even accessing `ctx.remaining_accounts` creates a borrow** with Context's lifetime parameters. When we call:
```rust
parse_ztoken_accounts(ctx.remaining_accounts, ...)
```

Rust sees:
- We're accessing Context (lifetime parameter '1)
- We'll later access ctx.accounts (lifetime parameter '2)
- These lifetimes are incompatible in Rust's type system

## Next Steps

We need to ensure that accessing `ctx.remaining_accounts` doesn't conflict with later accessing `ctx.accounts`. Options:

1. **Complete restructuring**: Move ALL remaining_accounts operations into a helper function that takes Context, does everything, then returns values (not AccountInfos)
2. **Isolate scopes**: Use a scoped block pattern to ensure lifetimes don't overlap
3. **Separate instructions**: Split into two instructions (one for CPIs, one for updates)

The most scalable approach is #1 - create a helper that takes Context and returns only primitive values (commitments, amounts), then update pool_state after.

