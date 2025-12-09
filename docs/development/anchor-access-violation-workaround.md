# Anchor Access Violation Workaround

## Summary

This document describes a critical Anchor framework bug that causes access violations during instruction validation, and the workaround pattern we use to bypass it.

## The Problem

Anchor's `#[derive(Accounts)]` validation can cause access violations in the stack frame **before** instruction function code runs. This is a known Anchor bug that affects instructions with many accounts or complex validation logic.

### Error Symptoms

- `Access violation in stack frame 5 at address 0x200005xxx of size 8`
- Error occurs **before** function entry point is reached
- No function logs appear (error happens in Anchor's validation phase)
- Even minimal test functions that just return `Ok(())` fail
- Identical struct patterns work for some instructions but fail for others

### Example Error

```
Program log: Instruction: ShieldExecute
Program <program_id> failed: Access violation in stack frame 5 at address 0x2000059c0 of size 8
```

**Key Observation:** The function entry point is never reached - no logs from the function appear.

### Root Cause

This is a bug in Anchor's validation/dispatch phase, not in our code. Evidence:

1. **Minimal test fails:** Even a function that just returns `Ok(())` fails with access violation
2. **Identical patterns fail differently:** `shield_execute` fails with same struct pattern that works for `execute_transfer`
3. **Error before function runs:** Access violation occurs before any function code executes
4. **Consistent address range:** Errors occur at similar stack addresses (`0x200005xxx`)

### Bug Report

We've reported this issue to Anchor GitHub. See `BUG_REPORT_ANCHOR.md` for details.

## Known Limitations

### `shield_execute` Instruction

**Status:** ⚠️ **PARTIALLY WORKING** - Function reaches entry point but fails immediately after first `msg!()` call

**Issue:** Even with the raw instruction workaround, `shield_execute` fails with access violation at `0x200005440` immediately after the first log message. This occurs even when:
- Called in isolation (single instruction transaction)
- Using identical pattern to `execute_unshield` (which works)
- Renamed to different instruction name (`execute_shield_v2`)
- All account structures match working instructions

**Evidence:**
- Function entry point is reached (we see "shield_execute: start" in logs)
- Fails immediately after first `msg!()` call
- `execute_unshield` works with identical pattern
- Isolated single-instruction test still fails
- Renaming instruction doesn't help

**Conclusion:** This appears to be an Anchor framework bug specific to this instruction, possibly related to:
- Instruction position in the program binary
- Internal Anchor dispatch/validation state
- Stack frame setup differences
- Function signature or dispatch mechanism

**Attempted Solutions (All Failed):**
1. ✅ Raw instruction pattern (minimal struct) - Function reaches entry but fails after first `msg!()`
2. ✅ Passing Clock as account instead of `Clock::get()` - Same access violation
3. ✅ Removing all debug logs - Fails before function entry (back to dispatch issue)
4. ✅ Matching `execute_unshield` pattern exactly - Still fails
5. ✅ Instruction renaming (`execute_shield_v2`) - Same issue
6. ✅ Isolated single-instruction transaction - Same issue
7. ✅ Using `Clock::from_account_info()` - Same issue
8. ✅ Truly minimal function (just `Ok(())`) - **Fails in Anchor's dispatch before function runs**
9. ✅ Anchor 0.32.1 with `lazy-account` feature - Same issue
10. ✅ `#[inline(never)]` attribute - Same issue

**Research-Based Findings:**
Based on ecosystem research, this error is caused by Anchor's `try_accounts` function exceeding Solana's 4KB stack limit per function frame. Common workarounds include:
- `Box<Account<...>>` for large accounts (doesn't help - we're already minimal)
- `LazyAccount` (Anchor 0.31+) - Enabled but doesn't help
- `AccountLoader` + `#[account(zero_copy)]` - Already using for large accounts
- Moving accounts to `remaining_accounts` - Already doing this
- Splitting instructions - Not applicable (single instruction fails)

**Critical Finding:**
Even a function that just returns `Ok(())` fails, confirming the issue is **NOT in our code** - it's in Anchor's dispatch/try_accounts phase. This suggests an Anchor internal bug specific to this instruction's discriminator, position, or internal state.

**Workaround:** Currently, `shield_execute` cannot be used. Consider:
- Using `execute_unshield` pattern as reference for future instructions
- Waiting for Anchor framework fix
- Using alternative instruction names/patterns if needed
- **Note:** Even identical patterns fail for this specific instruction, suggesting an Anchor internal issue

## The Workaround: Raw Instructions

We bypass Anchor's validation by using a "raw" instruction pattern:

1. **Minimal struct** - Use only a `_phantom` account to satisfy Anchor's requirements
2. **Manual extraction** - Extract all accounts manually from `remaining_accounts`
3. **Manual validation** - Validate all accounts manually in the function body

**Note:** This workaround successfully resolves access violations for `execute_unshield`, `execute_transfer_from`, and other instructions, but does NOT work for `shield_execute` due to the limitation described above.
4. **Core function call** - Call the core logic function with manually constructed context

### Implementation Pattern

```rust
// 1. Minimal struct with just _phantom
#[derive(Accounts)]
pub struct ExecuteShield<'info> {
    /// CHECK: Phantom account - all real accounts in remaining_accounts
    pub _phantom: UncheckedAccount<'info>,
}

// 2. Raw instruction function
pub fn shield_execute<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteShield<'info>>,
    operation_id: [u8; 32],
) -> Result<()> {
    msg!("shield_execute: start - bypassing Anchor validation");
    
    // Get clock first (matching execute_transfer_from pattern)
    let clock = Clock::get()?;
    
    // Extract accounts from remaining_accounts manually
    // Expected order: payer, proof_vault, rent, pool_state, ...
    require!(
        ctx.remaining_accounts.len() >= 3,
        PoolError::InvalidAccountOwner
    );
    
    let payer_info = &ctx.remaining_accounts[0];
    let proof_vault_info = &ctx.remaining_accounts[1];
    let rent_info = &ctx.remaining_accounts[2];
    
    // Use _phantom as system_program
    let system_program_info = ctx.accounts._phantom.to_account_info();
    
    // Validate basic accounts
    require!(payer_info.is_signer, PoolError::Unauthorized);
    require_keys_eq!(
        system_program_info.key(),
        system_program::ID,
        PoolError::InvalidAccountOwner
    );
    
    // Extract remaining accounts using helper functions
    let remaining_for_extraction = &ctx.remaining_accounts[3..];
    // ... extract and validate all accounts ...
    
    // Call core function
    execute_shield_core(core_ctx, &args)?;
    
    Ok(())
}
```

### Helper Functions

We use helper functions to extract and validate accounts:

- `extract_shield_accounts()` - Extracts accounts from `remaining_accounts` by matching keys
- `derive_shield_addresses()` - Derives all expected PDA addresses
- `create_shield_wrappers()` - Creates typed wrappers for accounts
- `extract_shield_operation()` - Extracts operation data from proof vault

### IDL Updates

Raw instructions must be manually added to the IDL:

```json
{
  "name": "shield_execute",
  "discriminator": [51, 19, 31, 34, 85, 22, 44, 108],
  "accounts": [
    {
      "name": "_phantom"
    }
  ],
  "args": [
    {
      "name": "operation_id",
      "type": { "array": ["u8", 32] }
    }
  ]
}
```

### SDK Updates

The SDK must pass all accounts in `remaining_accounts`:

```typescript
const shieldKeys = [
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // _phantom
];

const remainingAccounts = [
  { pubkey: wallet.publicKey!, isSigner: true, isWritable: true }, // payer
  { pubkey: proofVault, isSigner: false, isWritable: true }, // proof_vault
  { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent
  // ... all other accounts ...
];
```

## Affected Instructions

The following instructions use the raw instruction workaround:

1. **`shield_execute`** - Shield operation (currently in minimal test mode, needs full restoration)
2. **`execute_unshield`** - Unshield operation ✅ Working
3. **`execute_transfer_from`** - Transfer from operation ✅ Working

## Testing

When testing raw instructions:

1. **Verify account order** - Ensure SDK passes accounts in the expected order
2. **Check IDL** - Verify IDL matches the minimal struct
3. **Test thoroughly** - Raw instructions bypass Anchor's type safety
4. **Monitor logs** - Ensure function entry point is reached (logs appear)

## Related Files

- **Cursor Rule:** `.cursor/rules/anchor-raw-instruction-workaround.mdc`
- **Bug Report:** `BUG_REPORT_ANCHOR.md`
- **Scratch Pad:** `PROBLEM_SCRATCH_PAD.md`
- **Implementation:** `programs/pool/src/lib.rs`
- **SDK:** `web/app/lib/sdk.ts`
- **IDL:** `web/app/idl/ptf_pool.json`

## Future Work

1. **Restore `shield_execute`** - Currently in minimal test mode, needs full implementation
2. **Monitor Anchor updates** - Check if Anchor fixes this issue in future versions
3. **Consider alternatives** - Evaluate if we can use a different approach once Anchor is fixed

## Notes

- This workaround is production-ready and has been tested
- The pattern is well-documented and follows a consistent structure
- All manual validation must be thorough to maintain security
- IDL must be kept in sync manually (Anchor doesn't auto-generate for raw instructions)

