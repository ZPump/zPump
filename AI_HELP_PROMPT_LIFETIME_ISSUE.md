# Help Request: Rust Lifetime Conflict with Anchor Framework Context

## Executive Summary

We are encountering a persistent Rust lifetime conflict when trying to integrate zToken CPI (Cross-Program Invocation) calls within an Anchor-based Solana program. Despite multiple attempted solutions following Rust best practices, we cannot resolve the borrow checker errors that prevent accessing both `ctx.remaining_accounts` and `ctx.accounts` in the same instruction handler, even when used sequentially.

## IMPORTANT: What We Need You To Do

**Please do not just provide suggestions - we need you to:**
1. **Implement the solution** - Make the actual code changes to fix the lifetime issue
2. **Test that it compiles** - Run `cargo check` and ensure there are no compilation errors
3. **Verify the solution works** - The code should compile without lifetime conflicts
4. **Update all necessary files** - Fix the code in the actual files, not just show examples

We've spent significant time on this and have tried 7 different approaches. We need a working implementation, not just guidance.

## Problem Description

### Context: What We're Building

We're building a decentralized exchange (DEX) program on Solana using the Anchor framework. The DEX supports both public tokens and private tokens (zTokens). When users add liquidity with zTokens, we need to:

1. Update public reserves (via `ctx.accounts.pool_state`)
2. Perform a CPI call to transfer zTokens from user to pool PDA (requires accounts from `ctx.remaining_accounts`)
3. Update private reserve commitments in `pool_state` after the CPI

### The Core Problem

Anchor's `Context` type has multiple lifetime parameters:
```rust
Context<'info, 'a, 'b, 'c, AccountsStruct<'info>>
```

- `ctx.accounts` (typed account struct) has one lifetime scope
- `ctx.remaining_accounts` (untyped account slice) has a different lifetime scope
- These are separate borrows from the same Context, with incompatible lifetime parameters

### What We're Trying To Do

In our `add_liquidity` instruction handler, we need to:

1. **Access `ctx.accounts.pool_state`** (mutable borrow) to:
   - Read current reserves
   - Calculate LP tokens to mint
   - Update public reserves for public tokens
   - Update total LP supply

2. **Drop the mutable borrow** to release it

3. **Access `ctx.remaining_accounts`** to:
   - Parse zToken pool accounts (pool_state, commitment_tree, nullifier_set, etc.)
   - Parse payer, system_program, rent accounts (added by SDK)
   - Build a CPI instruction to transfer zTokens

4. **Access `ctx.accounts` again** to:
   - Update private reserve commitments in `pool_state`
   - Mint LP tokens using accounts from `ctx.accounts`

### The Lifetime Conflict Error

When we try to access `ctx.remaining_accounts`, Rust's borrow checker reports:

```
error: lifetime may not live long enough
   --> programs/dex/src/instructions/add_liquidity.rs:157:35
    |
 16 |     ctx: Context<crate::AddLiquidity>,
    |     ---
    |     |
    |     has type `anchor_lang::context::Context<'_, '_, '1, '_, AddLiquidity<'_>>`
    |     has type `anchor_lang::context::Context<'_, '_, '_, '2, AddLiquidity<'_>>`
...
157 |     let ztoken_accounts = crate::ztoken_cpi::parse_ztoken_accounts(
158 |         ctx.remaining_accounts,
```

The error shows that:
- When accessing `ctx.remaining_accounts`, Rust sees lifetime parameter `'1`
- When later accessing `ctx.accounts.payer`, Rust sees lifetime parameter `'2`
- Rust says: "`'1` must outlive `'2`" but also "`'2` must outlive `'1`" - **contradiction!**

## What We've Tried (All Failed)

### Attempt 1: Drop mutable borrow first

**Approach:** Drop `pool_state` mutable borrow before accessing `remaining_accounts`

```rust
let pool_state = &mut ctx.accounts.pool_state;
// ... do work with pool_state ...
drop(pool_state);
// Now access remaining_accounts
let accounts = parse_ztoken_accounts(ctx.remaining_accounts, ...)?;
```

**Result:** ❌ Failed - Still accessing different parts of Context with different lifetimes

**Why it failed:** Dropping the mutable borrow doesn't resolve the fundamental lifetime parameter incompatibility between `ctx.accounts` and `ctx.remaining_accounts`.

---

### Attempt 2: Cache AccountInfos before drop

**Approach:** Extract AccountInfos from `ctx.accounts` before dropping `pool_state`, then use them after accessing `remaining_accounts`

```rust
let payer_info = ctx.accounts.payer.to_account_info();  // Cache before drop
let system_program_info = ctx.accounts.system_program.to_account_info();
let rent_info = ctx.accounts.rent.to_account_info();

drop(pool_state);  // Drop mutable borrow

// Access remaining_accounts for zToken accounts
let ztoken_accounts = parse_ztoken_accounts(ctx.remaining_accounts, ...)?;

// Try to use cached AccountInfos
account_infos.push(payer_info);  // ERROR: lifetime conflict
```

**Result:** ❌ Failed - Cached AccountInfos still have the original lifetime from `ctx.accounts` (`'2`), which conflicts with AccountInfos from `remaining_accounts` (`'1`)

**Why it failed:** Cloning or caching AccountInfo doesn't change its lifetime - it's still tied to the original Context lifetime scope.

---

### Attempt 3: Extract remaining_accounts to local variable

**Approach:** Extract `remaining_accounts` slice to break lifetime tie to Context

```rust
drop(pool_state);
let remaining_accounts = ctx.remaining_accounts;  // Extract slice
let ztoken_accounts = parse_ztoken_accounts(remaining_accounts, ...)?;
```

**Result:** ❌ Failed - The assignment itself creates a lifetime conflict

```
error: lifetime may not live long enough
   --> programs/dex/src/instructions/add_liquidity.rs:144:30
    |
144 |     let remaining_accounts = ctx.remaining_accounts;
    |                              ^^^^^^^^^^^^^^^^^^^^^^
    |     assignment requires that `'1` must outlive `'2`
```

**Why it failed:** Even extracting the slice doesn't work because the Context's lifetime parameters are fundamentally incompatible. The assignment requires lifetime `'1` to outlive `'2`, but they're from the same Context with different parameters.

---

### Attempt 4: Solution 1 - Unified Lifetime Scope (SDK Changes)

**Approach:** Have the SDK pass ALL accounts (payer, system_program, rent) via `remaining_accounts` instead of `ctx.accounts`. This way, all AccountInfos come from the same lifetime scope.

**SDK Changes:**
```typescript
// Add payer, system_program, rent to remaining_accounts
instructionKeys.push(
  { pubkey: payer, isSigner: true, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
);
```

**Program Changes:**
- Created `parse_cpi_common_accounts()` function to extract payer/system/rent from `remaining_accounts`
- Updated instruction handler to use accounts from `remaining_accounts` only

```rust
// Get payer, system_program, rent from remaining_accounts (not ctx.accounts)
let (payer_account, system_program_account, rent_account) = 
    parse_cpi_common_accounts(ctx.remaining_accounts, &payer_pubkey)?;

// All AccountInfos now from remaining_accounts - same lifetime scope!
account_infos.push(payer_account);
account_infos.push(system_program_account);
account_infos.push(rent_account);
```

**Result:** ❌ Still Failed - Even though all accounts come from `remaining_accounts`, accessing `ctx.remaining_accounts` at all creates a borrow that conflicts with later accessing `ctx.accounts.pool_state`

**Why it failed:** The fundamental issue is that **accessing `ctx.remaining_accounts` creates a borrow tied to Context's lifetime parameters**, which prevents later accessing `ctx.accounts` even sequentially. The lifetime parameters are incompatible in Rust's type system.

---

### Attempt 5: Context-aware helper functions

**Approach:** Create helper functions that accept the full Context and handle all account extraction internally

```rust
pub fn invoke_transfer_for_add_liquidity_ctx<'info>(
    ctx: &Context<'info, AddLiquidity<'info>>,
    remaining_accounts: &'info [AccountInfo<'info>],
    origin_mint: &Pubkey,
    transfer_args: TransferArgs,
) -> Result<()> {
    // Access ctx.accounts inside the function
    // This should keep all lifetimes within the same Context scope
}
```

**Result:** ❌ Failed - Helper functions still hit the same lifetime conflict because they're just moving the problem to a different location.

**Why it failed:** The Context lifetime parameters are the same whether we access them in the main function or in a helper. Rust's borrow checker still sees the incompatibility.

---

### Attempt 6: Completely inline CPI construction

**Approach:** Build the CPI instruction completely inline, accessing all AccountInfos in the same lexical scope

```rust
// All in one scope, no helper function calls
let ztoken_accounts = parse_ztoken_accounts(ctx.remaining_accounts, ...)?;
let (payer, system, rent) = parse_cpi_common_accounts(ctx.remaining_accounts, ...)?;

// Build instruction inline
let mut account_infos = Vec::new();
account_infos.push(ztoken_accounts.pool_state.clone());
account_infos.push(payer);
// ... etc
```

**Result:** ❌ Failed - Still accessing `ctx.remaining_accounts` which creates the lifetime conflict

**Why it failed:** The problem isn't about scope or helper functions - it's about accessing Context's different lifetime scopes at all.

---

### Attempt 7: Scoped Block Pattern (Latest Attempt)

**Approach:** Based on a solution document that suggests using scoped blocks to isolate borrows. The pattern recommends:
1. Cache only scalar data from `ctx.accounts` upfront
2. Parse `remaining_accounts` in a short-lived scope (scoped block)
3. Reborrow `ctx.accounts` in a new scope after the block ends

**Implementation:**
```rust
// 1) Cache only scalars from typed accounts
let pool_state_key = ctx.accounts.pool_state.key();
let payer_pubkey = ctx.accounts.payer.key();

// 2) Parse remaining accounts in their own scope so the borrow ends
let ztoken_accounts = {
    let ra: &[AccountInfo<'_>] = ctx.remaining_accounts;
    parse_ztoken_accounts(ra, &pool_state_key, &payer_pubkey)?
}; // `ra` borrow ends here

// 3) Now freely borrow from ctx.accounts again
{
    let pool_state = &mut ctx.accounts.pool_state;
    // update reserves, commitments, etc.
}
```

**What We Actually Implemented:**

We applied this pattern to both token A and token B zToken handling:

```rust
// Scoped block: All remaining_accounts access happens here
// The borrow ends when this block closes
let (commitment_a, amount_a_result) = {
    // Borrow remaining_accounts in this scope only
    // Use explicit type annotation to make scope clear
    let ra: &[AccountInfo<'_>] = ctx.remaining_accounts;
    
    require!(!ra.is_empty(), DexError::InvalidAccount);
    
    // Parse zToken accounts from remaining_accounts
    let ztoken_accounts = crate::ztoken_cpi::parse_ztoken_accounts(
        ra,
        &token_a,
        &POOL_PROGRAM_ID,
        false,
    )?;
    
    // Build CPI instruction completely inline
    // ... construct instruction and invoke CPI ...
    
    // Extract commitment for pool state update (return scalar values only)
    let commitment = extract_pool_commitment(...);
    let amount_result = ...;
    
    // Return only scalar values - no AccountInfos
    (commitment, amount_result)
}; // remaining_accounts borrow ends here

// Store commitment results for later pool state update
if let Some(commitment) = commitment_a {
    if let Some(amount) = amount_a_result {
        new_private_reserve_a_commitment = Some(commitment);
        new_private_reserve_a_amount = Some(amount);
    }
}

// Later: Re-access ctx.accounts.pool_state in separate scope
let pool_state = &mut ctx.accounts.pool_state;
// Update private reserve commitments
```

**Result:** ❌ Still Failed - The assignment to `ra` within the scoped block creates a lifetime conflict

**Error:**
```
error: lifetime may not live long enough
   --> programs/dex/src/instructions/add_liquidity.rs:156:46
    |
156 |                 let ra: &[AccountInfo<'_>] = ctx.remaining_accounts;
    |                                              ^^^^^^^^^^^^^^^^^^^^^^
    |     assignment requires that `'1` must outlive `'2`
```

**Why it failed:** Even within a scoped block, assigning `ctx.remaining_accounts` to a local variable (`let ra: &[AccountInfo<'_>] = ctx.remaining_accounts;`) creates a lifetime conflict. The assignment itself requires lifetime `'1` (from remaining_accounts) to outlive lifetime `'2` (from accounts), which are incompatible Context lifetime parameters.

**Key Insight:** The problem occurs at the **assignment statement itself**, not just when using the variable. Even extracting `ctx.remaining_accounts` to a local variable within a scoped block triggers the lifetime conflict.

**What We Need:**

We need clarification on:

1. **Can we use `ctx.remaining_accounts` without assigning it to a variable?** 
   - Should we pass it directly to functions without intermediate assignment?
   - Example: `parse_ztoken_accounts(ctx.remaining_accounts, ...)?` directly?

2. **Is there a different way to structure the scoped block?**
   - The solution document shows the pattern, but maybe we're missing something about how to properly isolate the borrow?

3. **Are there additional constraints we need to follow?**
   - Should we avoid accessing `ctx` at all after the scoped block?
   - Do we need to restructure the function signature or Context usage?

4. **Is this pattern specific to a particular Anchor version or Context structure?**
   - Does it require a different Anchor Context API?
   - Are there Anchor-specific helper methods we should use?

5. **Can the solution work if we complete ALL remaining_accounts operations before re-accessing ctx.accounts?**
   - We tried doing both token A and token B CPIs in scoped blocks, then accessing ctx.accounts afterward
   - But even the first scoped block assignment causes the error

**Current Status:**
- ✅ SDK changes complete (payer, system_program, rent in remaining_accounts)
- ✅ Parsing functions ready
- ✅ Code structure follows scoped block pattern
- ❌ Cannot compile due to lifetime conflict on assignment

The scoped block approach seems correct in theory, but we're hitting the fundamental limitation that **even assigning `ctx.remaining_accounts` to a variable triggers the lifetime conflict**. We need guidance on whether:
- We should skip the assignment and use it directly
- There's a different pattern that avoids the assignment conflict
- This is a known Anchor limitation that requires a workaround

---

## Current Code Structure

### Instruction Handler (Simplified)

```rust
pub fn add_liquidity(
    ctx: Context<crate::AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
    min_lp_tokens: u64,
    transfer_args_a: Option<TransferArgs>,
    transfer_args_b: Option<TransferArgs>,
) -> Result<()> {
    // Cache primitive values (keys, not AccountInfos)
    let token_a = ctx.accounts.token_a_mint.key();
    let token_b = ctx.accounts.token_b_mint.key();
    let pool_state_key = ctx.accounts.pool_state.key();
    let payer_pubkey = ctx.accounts.payer.key();
    
    // Read pool_state immutably to cache values
    let pool_state_ref = &ctx.accounts.pool_state;
    let token_a_is_ztoken = pool_state_ref.token_a_is_ztoken;
    let token_b_is_ztoken = pool_state_ref.token_b_is_ztoken;
    
    // Take mutable borrow for updates
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Update public reserves for public tokens
    // Calculate LP tokens
    // Update total LP supply
    
    // Drop mutable borrow
    drop(pool_state);
    
    // ❌ PROBLEM AREA: Accessing remaining_accounts creates lifetime conflict
    if token_a_is_ztoken {
        if let Some(transfer_args) = transfer_args_a {
            // This line causes the lifetime error:
            let ztoken_accounts = parse_ztoken_accounts(
                ctx.remaining_accounts,  // ❌ Lifetime conflict here
                &token_a,
                &POOL_PROGRAM_ID,
                false,
            )?;
            
            // Build CPI instruction using accounts from remaining_accounts
            // Invoke CPI
        }
    }
    
    // Later: Re-access ctx.accounts.pool_state
    let pool_state = &mut ctx.accounts.pool_state;  // ❌ Conflicts with earlier remaining_accounts access
    // Update private reserve commitments
}
```

### Account Struct Definition

```rust
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut, seeds = [...], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,
    
    pub token_a_mint: AccountInfo<'info>,
    pub token_b_mint: AccountInfo<'info>,
    #[account(mut)]
    pub lp_token_mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_lp_token_account: AccountInfo<'info>,
    #[account(mut)]
    pub user_token_a_account: AccountInfo<'info>,
    #[account(mut)]
    pub pool_token_a_account: AccountInfo<'info>,
    #[account(mut)]
    pub user_token_b_account: AccountInfo<'info>,
    #[account(mut)]
    pub pool_token_b_account: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
```

### Parsing Functions

```rust
// Parses zToken pool accounts from remaining_accounts
pub fn parse_ztoken_accounts<'info>(
    remaining_accounts: &'info [AccountInfo<'info>],
    origin_mint: &Pubkey,
    _pool_program_id: &Pubkey,
    is_shield: bool,
) -> Result<ZTokenPoolAccounts<'info>> {
    // Finds and extracts: pool_state, commitment_tree, nullifier_set, etc.
    // Returns ZTokenPoolAccounts with all AccountInfos having lifetime 'info
}

// Parses common accounts (payer, system_program, rent) from remaining_accounts
pub fn parse_cpi_common_accounts<'info>(
    remaining_accounts: &'info [AccountInfo<'info>],
    payer_pubkey: &Pubkey,
) -> Result<(AccountInfo<'info>, AccountInfo<'info>, AccountInfo<'info>)> {
    // Extracts last 3 accounts: payer, system_program, rent
    // All AccountInfos have lifetime 'info from remaining_accounts
}
```

## Why This Is Hard

1. **AccountInfos are reference types** - They carry lifetime information and cannot be "detached" from their source
2. **Context has multiple lifetime parameters** - Different parts have different scopes that Rust sees as incompatible
3. **We can't "unify" lifetimes** - Rust's type system doesn't allow coercing different lifetime parameters to be the same
4. **Clone doesn't help** - Cloning AccountInfo still preserves the original lifetime
5. **Sequential access doesn't help** - Even if we use them at different times, Rust sees the potential for conflict based on lifetime parameters

## What We Need

We need a solution that allows us to:

1. ✅ Access `ctx.accounts.pool_state` for updates
2. ✅ Access `ctx.remaining_accounts` for zToken CPI accounts
3. ✅ Re-access `ctx.accounts.pool_state` after CPI to update private reserves
4. ✅ All without lifetime conflicts

**OR** we need an alternative architecture that achieves the same goal (transfer zTokens via CPI, update pool state) without mixing Context lifetime scopes.

## Questions for Help

1. **Is there a way to restructure the code** to avoid mixing Context lifetime scopes?
2. **Are there Anchor-specific patterns** for handling this scenario (CPI calls that need accounts from both `ctx.accounts` and `ctx.remaining_accounts`)?
3. **Can we restructure the instruction flow** to complete all `remaining_accounts` operations before re-accessing `ctx.accounts`? (We've tried this, but maybe there's a better way)
4. **Should we split into multiple instructions?** One for public token operations, one for zToken CPIs?
5. **Is there a way to extract AccountInfos** such that they lose their lifetime ties to Context?
6. **Are there Anchor version-specific solutions** or workarounds for this known issue?
7. **Should we modify the account struct** to include zToken accounts directly instead of using `remaining_accounts`?

## Additional Context

- **Anchor Version:** Latest (as of 2024)
- **Rust Version:** Latest stable
- **Solana Version:** Latest
- **Program:** Solana DEX program with zToken support
- **Full codebase:** Available in GitHub repository (see file paths below)

## File Locations

- Main instruction handler: `programs/dex/src/instructions/add_liquidity.rs`
- Account struct: `programs/dex/src/lib.rs`
- Parsing functions: `programs/dex/src/ztoken_cpi.rs`
- SDK: `web/app/lib/sdk.ts`
- Documentation: `LIFETIME_CONFLICT_EXPLAINED.md`, `SOLUTION_1_IMPLEMENTATION.md`

## Error Message Details

```
error: lifetime may not live long enough
   --> programs/dex/src/instructions/add_liquidity.rs:157:35
    |
 16 |     ctx: Context<crate::AddLiquidity>,
    |     ---
    |     |
    |     has type `anchor_lang::context::Context<'_, '_, '1, '_, AddLiquidity<'_>>`
    |     has type `anchor_lang::context::Context<'_, '_, '_, '2, AddLiquidity<'_>>`
...
157 |     let ztoken_accounts = crate::ztoken_cpi::parse_ztoken_accounts(
158 |         ctx.remaining_accounts,
159 |         &token_a,
160 |         &POOL_PROGRAM_ID,
161 |         false,
162 |     )?;
    |
    = note: the lifetime requirement is introduced here
    = note: the lifetime parameter `'1` must outlive the lifetime parameter `'2`
```

## What Would Success Look Like

A solution that:
- Allows the code to compile without lifetime errors
- Maintains the current architecture (CPI calls for zToken transfers)
- Follows Rust best practices (no unsafe code if possible)
- Is scalable and maintainable

## Request - ACTION REQUIRED

**IMPORTANT: Please implement the solution, don't just suggest it.**

We need you to:

1. **Implement the fix** - Make the actual code changes to resolve the lifetime conflict
   - Modify the files in `programs/dex/src/instructions/add_liquidity.rs`
   - Update any helper functions in `programs/dex/src/ztoken_cpi.rs` if needed
   - Make whatever changes are necessary to get it compiling

2. **Test the solution** - Verify it works:
   - Run `cargo check` or `cargo build` in `programs/dex/`
   - Ensure there are NO lifetime errors
   - Confirm the program compiles successfully
   - If there are other errors, fix those too

3. **Explain what you did** - After implementing:
   - Explain why the solution works
   - Explain why previous attempts failed
   - Document any key insights about Anchor's Context lifetime system

4. **Provide working code** - Not just examples, but the actual implementation that compiles

### Specific Questions to Address

While implementing, please address:
1. Why the scoped block pattern (Attempt 7) still fails on assignment
2. Whether we can use `ctx.remaining_accounts` without assigning it to a variable
3. What we're missing about isolating borrows in scoped blocks
4. How to properly implement the scoped block pattern if that's the correct approach
5. Alternative patterns if scoped blocks don't work with Anchor's Context
6. Any known limitations or workarounds in the Anchor framework

### Testing Requirements

**Before marking this as complete:**
- ✅ `cargo check` in `programs/dex/` must pass with no errors
- ✅ No lifetime conflicts in the output
- ✅ All CPI calls must be enabled and functional
- ✅ Code must follow Rust and Anchor best practices

### File Locations

- Main instruction handler: `programs/dex/src/instructions/add_liquidity.rs` (around lines 140-420)
- Parsing functions: `programs/dex/src/ztoken_cpi.rs`
- Account struct: `programs/dex/src/lib.rs`

### What We've Tried

We've documented 7 different attempts in this file. The latest (Attempt 7) was the scoped block pattern, which still failed because even assigning `ctx.remaining_accounts` to a local variable within a scoped block causes the lifetime conflict.

**Bottom line:** We need working code that compiles, not just explanations. Please implement the fix and test it.

Thank you for your help!


---

## Additional Technical Details

### Anchor Context Lifetime Parameters Explained

Anchor's `Context` type signature (simplified):
```rust
pub struct Context<'a, 'b, 'c, 'd, 'info, Accounts> {
    pub accounts: Accounts,  // Has lifetime 'b (or similar)
    pub remaining_accounts: Vec<AccountInfo<'info>>,  // Has lifetime 'c (or similar)
    // ... other fields
}
```

The issue is that `'b` and `'c` are different lifetime parameters, and Rust's borrow checker sees them as incompatible even when used sequentially.

### What parse_ztoken_accounts Returns

```rust
pub struct ZTokenPoolAccounts<'info> {
    pub pool_state: AccountInfo<'info>,
    pub commitment_tree: AccountInfo<'info>,
    pub nullifier_set: AccountInfo<'info>,
    pub note_ledger: AccountInfo<'info>,
    pub mint_mapping: AccountInfo<'info>,
    pub verifier_program: AccountInfo<'info>,
    pub verifying_key: AccountInfo<'info>,
    // Optional fields for shield operations
    pub vault_state: Option<AccountInfo<'info>>,
    // ...
}
```

All AccountInfos in this struct have lifetime `'info` which is tied to the `remaining_accounts` slice lifetime.

### Why We Can't Use Unsafe

While `unsafe` could potentially work around the borrow checker, we want to:
1. Maintain Rust's safety guarantees
2. Follow Anchor best practices
3. Keep code maintainable and auditable

Unsafe should be a last resort.

### Alternative Architecture Considered

We considered splitting into two instructions:
1. `add_liquidity_public` - handles public tokens only
2. `add_liquidity_ztoken` - handles zToken CPIs separately

But this would:
- Require users to make multiple transactions
- Break atomicity (liquidity addition should be atomic)
- Complicate the frontend/SDK
- Not solve the fundamental lifetime issue

### What Success Would Enable

If we solve this, we can:
- Complete the zToken integration for add_liquidity
- Apply the same pattern to remove_liquidity
- Apply the same pattern to swap (which has even more complex CPI requirements)
- Have a scalable, maintainable solution for mixing ctx.accounts and ctx.remaining_accounts

### Additional Context About the Codebase

- The DEX program is permissionless
- Pools can have any combination: token/token, zToken/zToken, token/zToken
- zTokens must NEVER be unshielded (always stay private)
- Pool PDA acts as a "user" in the private pool system
- All zToken operations use CPI calls to ptf_pool program

### Known Anchor Patterns

We've looked at other Anchor programs but haven't found examples of:
- Programs that need to access both ctx.accounts and ctx.remaining_accounts in the same instruction
- Programs that need to re-access ctx.accounts after using remaining_accounts

Most examples either:
- Use only ctx.accounts
- Use only ctx.remaining_accounts
- Don't re-access ctx.accounts after using remaining_accounts

### Debugging Information

When we get the lifetime error, Rust shows:
```
= note: the lifetime requirement is introduced here
= note: the lifetime parameter `'1` must outlive the lifetime parameter `'2`
```

But `'1` and `'2` are both part of the same Context, so they should have compatible lifetimes. The issue is that Anchor's Context design intentionally separates them for safety, but this prevents legitimate use cases.

### What We've Learned

Through this process, we've learned:
1. Anchor's Context lifetime system is very strict
2. Sequential access doesn't resolve lifetime conflicts if they're different parameters
3. Extracting/borrowing doesn't help - lifetimes persist
4. The SDK approach (unifying accounts in remaining_accounts) is correct in theory, but accessing remaining_accounts at all creates the conflict
5. **Even assigning `ctx.remaining_accounts` to a local variable within a scoped block triggers the lifetime conflict** - the assignment statement itself is the problem, not just using the variable afterward
6. Scoped blocks help conceptually, but don't resolve the fundamental Context lifetime parameter incompatibility

### Final Thoughts

We believe this is a legitimate use case that should be possible in Anchor. The code structure is correct, the logic is sound, but Rust's borrow checker (correctly) sees the lifetime parameter mismatch and prevents it.

Any solution that:
- Allows compilation
- Maintains code clarity
- Follows best practices
- Is maintainable

...would be greatly appreciated.

Thank you again for your time and expertise!
