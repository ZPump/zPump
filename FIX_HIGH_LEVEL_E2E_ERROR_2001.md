# Fix High-Level E2E Test Error 2001 in set_lookup_table

## Problem Summary

The high-level E2E test (`browser-e2e.ts`) is failing when calling `set_lookup_table` instruction with error code 2001 (0x7d1). However, the low-level E2E test (`lowlevel-e2e.ts`) successfully calls the same instruction with identical parameters. The error occurs specifically in the browser-e2e test's wallet adapter implementation.

## Context

We are implementing a migration to store Address Lookup Table addresses directly in the `MintMapping` account on-chain. The `set_lookup_table` instruction is responsible for storing the lookup table address in the `MintMapping` account.

### What Works

- **Low-level E2E test**: All tests pass, including `set_lookup_table` instruction
- **The instruction itself**: Works correctly when called from lowlevel-e2e
- **Lookup table creation**: Successfully creates and activates lookup tables
- **Account resizing**: Correctly handles old (85-byte) and new (114-byte) MintMapping accounts

### What Doesn't Work

- **High-level E2E test**: Fails with error 2001 (0x7d1) when calling `set_lookup_table`
- **Error occurs**: During transaction execution, not during simulation (we use `skipPreflight: true`)

## Error Details

- **Error Code**: 2001 (0x7d1 in hex)
- **Error Type**: `{"InstructionError":[0,{"Custom":2001}]}`
- **Occurrence**: During `set_lookup_table` instruction execution in browser-e2e test
- **Note**: Error 2001 does NOT match standard Anchor error codes (which start at 6000/0x1770)

### Error Message
```
Signature <signature> failed: {"InstructionError":[0,{"Custom":2001}]}
```

## Code Locations

### Working Implementation (lowlevel-e2e.ts)

**File**: `web/app/scripts/lowlevel-e2e.ts`
**Lines**: ~958-985

```typescript
const setLookupTableData = factoryCoder.instruction.encode('set_lookup_table', {});
const setLookupTableIx = new TransactionInstruction({
  programId: FACTORY_PROGRAM_ID,
  keys: [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: adminAuthority.publicKey, isSigner: true, isWritable: false },
    { pubkey: mintMapping, isSigner: false, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: lookupTableAddress, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
  ],
  data: setLookupTableData
});

const setBlockhash = await connection.getLatestBlockhash('confirmed');
const setTx = new Transaction().add(setLookupTableIx);
setTx.feePayer = adminAuthority.publicKey;
setTx.recentBlockhash = setBlockhash.blockhash;
setTx.sign(adminAuthority); // Direct signing with Keypair

const setSignature = await connection.sendRawTransaction(setTx.serialize(), { skipPreflight: true });
```

**Key characteristics:**
- Uses `Keypair` directly for signing (`setTx.sign(adminAuthority)`)
- Sends via `connection.sendRawTransaction()` directly
- Uses `skipPreflight: true`

### Failing Implementation (sdk.ts → browser-e2e.ts)

**File**: `web/app/lib/sdk.ts`
**Function**: `setLookupTableForMint`
**Lines**: ~597-661

```typescript
export async function setLookupTableForMint(
  connection: Connection,
  wallet: WalletContextState,
  originMint: PublicKey,
  lookupTable: PublicKey
): Promise<string> {
  const factoryState = deriveFactoryState();
  const mintMapping = deriveMintMapping(originMint);

  const setLookupTableData = factoryCoder.instruction.encode('set_lookup_table', {});
  const setLookupTableInstruction = new TransactionInstruction({
    programId: FACTORY_PROGRAM_ID,
    keys: [
      { pubkey: factoryState, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey!, isSigner: true, isWritable: false },
      { pubkey: mintMapping, isSigner: false, isWritable: true },
      { pubkey: originMint, isSigner: false, isWritable: false },
      { pubkey: lookupTable, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: setLookupTableData
  });

  const blockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction().add(setLookupTableInstruction);
  transaction.feePayer = wallet.publicKey!;
  transaction.recentBlockhash = blockhash.blockhash;
  
  let signature: string;
  if (wallet.signTransaction) {
    const signedTx = await wallet.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: true
    });
  } else {
    signature = await wallet.sendTransaction(transaction, connection, {
      skipPreflight: true
    });
  }
  
  await waitForSignatureConfirmation(connection, signature, blockhash.blockhash, blockhash.lastValidBlockHeight);
  return signature;
}
```

**File**: `web/app/scripts/browser-e2e.ts`
**Function**: `createWalletAdapter`
**Lines**: ~630-669

```typescript
function createWalletAdapter(payer: Keypair, connection: Connection): WalletLike {
  const adapter = {
    publicKey: payer.publicKey,
    // ... other wallet adapter properties ...
    async sendTransaction(transaction: Transaction | VersionedTransaction, connection: Connection, options?: { skipPreflight?: boolean }): Promise<string> {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([payer]);
        return connection.sendRawTransaction(transaction.serialize(), { skipPreflight: options?.skipPreflight ?? false });
      }
      transaction.sign(payer);
      return connection.sendRawTransaction(transaction.serialize(), { skipPreflight: options?.skipPreflight ?? false });
    },
    async signTransaction(transaction: Transaction) {
      transaction.sign(payer);
      return transaction;
    },
    // ... other methods ...
  };
  return adapter as unknown as WalletLike;
}
```

## Key Differences

1. **Signing method**:
   - **lowlevel-e2e**: Direct `Keypair.sign()` on transaction
   - **browser-e2e**: Wallet adapter's `signTransaction()` which calls `transaction.sign(payer)`

2. **Transaction construction**:
   - **lowlevel-e2e**: Builds transaction, sets fee payer, signs, then sends
   - **browser-e2e**: Same flow, but goes through wallet adapter interface

3. **Wallet type**:
   - **lowlevel-e2e**: Uses `Keypair` directly
   - **browser-e2e**: Uses `WalletContextState` adapter that wraps `Keypair`

## Rust Program Structure

**File**: `programs/factory/src/lib.rs`

The `set_lookup_table` instruction expects these accounts in order:

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

## What We've Tried

1. ✅ Changed `partialSign()` to `sign()` in browser-e2e wallet adapter
2. ✅ Added `skipPreflight` support to browser-e2e wallet adapter
3. ✅ Updated `setLookupTableForMint` to use `signTransaction()` directly
4. ✅ Added account verification before storing lookup table
5. ✅ Improved lookup table activation checks
6. ✅ Verified account ordering matches Rust program structure
7. ✅ Added wait times for account data propagation

## Hypothesis

Error 2001 (0x7d1) doesn't match standard Anchor error codes. Possible causes:

1. **Constraint violation**: Anchor constraint check failing (but error code doesn't match)
2. **Account access issue**: Lookup table account not accessible when instruction executes
3. **Transaction signing issue**: Transaction not properly signed or serialized
4. **Account ordering issue**: Accounts in wrong order (but they match Rust struct)
5. **Account mutability issue**: Account marked wrong (writable/read-only)
6. **Program ID mismatch**: Wrong program ID (unlikely, lowlevel-e2e works)

The fact that lowlevel-e2e works suggests the instruction itself is correct. The issue is likely in how the transaction is being constructed or signed in the browser-e2e context.

## What Needs to Be Fixed

1. **Identify the root cause** of error 2001 in browser-e2e context
2. **Fix the transaction construction/signing** to match lowlevel-e2e behavior exactly
3. **Ensure the fix works** in both lowlevel-e2e and browser-e2e tests
4. **Verify** by running the full test suite: `./scripts/run-full-test-suite.sh`

## Debugging Suggestions

1. **Compare transaction bytes**: Serialize both transactions (lowlevel-e2e and browser-e2e) and compare byte-by-byte
2. **Check transaction signatures**: Verify both transactions have valid signatures
3. **Enable program logs**: Check if Rust program emits any logs that differ between the two contexts
4. **Account info comparison**: Verify all accounts have identical properties (owner, lamports, data, etc.) in both contexts
5. **Transaction simulation**: Try running simulation (without skipPreflight) to see if different errors appear
6. **Error code mapping**: Check if error 2001 maps to a different error system (not Anchor)

## Test Command

```bash
cd /home/hendo420/zPump
./scripts/run-full-test-suite.sh
```

The test will fail at the "High-Level E2E" section when trying to call `set_lookup_table`.

## Success Criteria

The fix is successful when:
1. `set_lookup_table` instruction executes without errors in browser-e2e test
2. The lookup table address is correctly stored in the `MintMapping` account
3. The high-level E2E test passes: `./scripts/run-full-test-suite.sh`
4. Low-level E2E tests continue to pass (no regressions)
5. Both test suites use consistent transaction handling

## Additional Context

- **Anchor version**: Check `Anchor.toml` for version
- **Solana version**: Check `package.json` for @solana/web3.js version
- **Both tests use**: Same RPC endpoint, same programs, same factory authority
- **Timing**: Lowlevel-e2e waits longer after lookup table activation before calling `set_lookup_table`
- **Account state**: Both should have identical MintMapping accounts (same size, same data)

## Files to Review

1. `web/app/lib/sdk.ts` - `setLookupTableForMint` function (lines ~597-661)
2. `web/app/scripts/browser-e2e.ts` - `createWalletAdapter` function (lines ~630-669)
3. `web/app/scripts/lowlevel-e2e.ts` - Working implementation (lines ~958-985)
4. `programs/factory/src/lib.rs` - `set_lookup_table` instruction (lines ~272-470)
5. `programs/factory/src/lib.rs` - `SetLookupTable` accounts struct (lines ~1656-1668)

## Next Steps

1. Compare the exact transaction bytes/instructions between working (lowlevel-e2e) and failing (browser-e2e) cases
2. Verify all accounts match exactly (pubkeys, mutability, signer status)
3. Check if transaction signing produces different results
4. Try to reproduce the issue by calling `setLookupTableForMint` from lowlevel-e2e using the wallet adapter pattern
5. Add detailed logging to compare transaction construction step-by-step

