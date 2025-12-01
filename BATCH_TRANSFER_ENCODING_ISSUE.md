# Batch Transfer Encoding Issue

## Problem

Anchor's Borsh encoder is failing when trying to encode BatchTransferArgs with minimal/empty dummy proofs in TransferArgs:
- Error: "Blob.encode[data] requires (length X) Buffer as src"
- Happens with both empty arrays `[]` and minimal arrays `[0]`

## Current Status

We've verified:
- ✅ **Real batch proof is used** - `batchProof.proof` is the actual cryptographic proof
- ✅ **Dummy proofs are ignored** - The program never reads `transfer_args.proof` in batch mode
- ✅ **All operations use real proofs** - Normal transfer, transferFrom, swap all use real proofs

## Solution

For now, we're keeping 192-byte dummy proofs in TransferArgs to ensure Anchor's encoder works. The important optimization (batch proof instead of 2 separate proofs) is already implemented.

## Next Steps

1. Fully manually serialize BatchTransferArgs (bypass Anchor's encoder completely)
2. OR fix Anchor's encoder to handle empty Vec<u8> properly
3. OR document that dummy proofs are required for encoding compatibility (they're ignored anyway)

The real savings come from using 1 batch proof instead of 2 separate proofs, which is already working!

