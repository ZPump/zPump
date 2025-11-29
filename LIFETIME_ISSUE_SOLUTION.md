# Lifetime Issue Solution

## Problem

Rust borrow checker prevents accessing `ctx.remaining_accounts` while holding mutable borrows of `pool_state`, or after dropping mutable borrows due to Context lifetime parameter conflicts.

## Root Cause

Anchor's `Context` has complex lifetime parameters. When we:
1. Take mutable borrow of `pool_state` (part of `ctx.accounts`)
2. Drop the mutable borrow
3. Try to access `ctx.remaining_accounts` for CPIs

Rust sees lifetime parameter conflicts between the different parts of Context.

## Best Practice Solution

Modify helper functions to accept the Context directly, avoiding the need to extract AccountInfos separately:

```rust
pub fn invoke_transfer_cpi_with_context<'info>(
    ctx: &Context<'info, AddLiquidity<'info>>,
    remaining_accounts: &'info [AccountInfo<'info>],
    transfer_args: TransferArgs,
    // ... other params
) -> Result<()> {
    // Access ctx.accounts directly inside the function
    // This keeps all lifetimes within the same Context scope
}
```

Or restructure to pass a closure that has access to the full Context.

## Alternative: Restructure Instruction Flow

Split into separate instructions or use Anchor's account validation differently to avoid the lifetime conflict.

