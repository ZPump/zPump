# Root Computation Mismatch Between Circuit and Tree

**Severity:** MEDIUM

**Location:** `programs/pool/src/lib.rs:1680-1692` (transfer) and `2026-2038` (unshield)

## Description

The zero-knowledge proof circuits compute `new_root` differently than the commitment tree's actual root computation. The circuit computes `new_root = poseidon(old_root, nullifiers)` for transfers and `new_root = poseidon(old_root, nullifier, change_commitment, change_amount_commitment)` for unshields, but the tree computes the root by actually appending commitments to the Merkle tree.

## Code Reference

### Transfer (lines 1680-1692):
```rust
// CRITICAL FIX: The transfer circuit's new_root is computed as poseidon(old_root, nullifiers)
// which doesn't include output commitments. The Groth16 proof verification already validates
// that the proof's new_root matches this computation. However, the actual tree root after
// appending outputs is different. We use computed_new_root (which includes outputs) as the
// actual state, but we've already validated that output commitments match the proof's public
// inputs in validate_transfer_public_inputs, preventing forged commitments.
// 
// TODO: Update circuit to compute new_root including output commitments for full validation
```

### Unshield (lines 2026-2038):
```rust
// CRITICAL FIX: The unshield circuit's new_root computation includes change commitments:
// new_root = poseidon(old_root, nullifier, change_commitment, change_amount_commitment)
// The tree's append_many computes the actual root after appending commitments to the tree.
// We use the tree's computed root as it represents the actual state, but we've already
// validated that output commitments and amount commitments match the proof's public
// inputs in validate_unshield_public_inputs, preventing forged commitments.
//
// TODO: Ensure circuit's new_root computation exactly matches tree's root computation
```

## Impact

- Potential for root drift if validation is not perfect
- Relies on multiple validation layers rather than direct circuit validation
- Could lead to inconsistencies if validation logic has bugs

## Current Mitigations

1. `validate_transfer_public_inputs` ensures output commitments match proof
2. `validate_unshield_public_inputs` ensures output commitments match proof
3. Groth16 verification validates proof's new_root computation
4. Tree's computed root is used as the actual state

## Recommendation

1. Update circuits to compute new_root exactly matching the tree's root computation
2. This would allow direct validation of the proof's new_root against the tree's root
3. Reduces reliance on multiple validation layers
4. Makes the security model simpler and more auditable

