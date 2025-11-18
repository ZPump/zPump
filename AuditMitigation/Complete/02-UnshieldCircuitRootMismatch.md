# Mitigation: Unshield Circuit Root Computation Mismatch

## Severity: CRITICAL
## Contract: ptf_pool
## Issue ID: 2

## Problem Description

Same issue as transfer circuit - the unshield circuit's new_root computation may not include output commitments. The code uses `computed_new_root` from the tree (which includes outputs) but the proof validates a different root.

## Security Impact

1. **Invalid Unshields:** Proofs can validate roots that don't match actual tree state
2. **State Inconsistency:** On-chain state diverges from proof-validated state
3. **Potential Exploitation:** Could allow invalid unshields if output commitments are manipulated

## Mitigation Strategies

### Option 1: Update Circuit (RECOMMENDED)
Same approach as transfer circuit fix. Update unshield circuit to include output commitments in root computation.

### Option 2: Enhanced Validation (TEMPORARY)
Add comprehensive validation that output commitments match proof public inputs, similar to transfer fix.

## Recommended Approach

Follow same approach as transfer circuit fix. Coordinate both fixes together since they're related.

## Code Changes

Similar to transfer circuit fix - update circuit to include outputs in root, or add validation that outputs match proof.

## Testing

Test unshield flow with new validation, ensure old proofs work if backward compatible.

## References

- Issue location: `programs/pool/src/lib.rs:1412-1416`
- Related function: `process_unshield()`

