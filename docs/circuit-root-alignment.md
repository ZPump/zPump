# Circuit-Tree Root Computation Alignment

## Status: PARTIALLY RESOLVED

**Update**: The commitment tree has been migrated to use Poseidon hashing (matching circuits). However, circuits still compute simplified roots rather than actual Merkle roots. Direct root validation is not yet possible, but both systems now use the same hash function (Poseidon), improving alignment.

## Overview

This document describes the current mismatch between how the zero-knowledge proof circuit computes the new Merkle root versus how the on-chain commitment tree computes it, and the required changes to align them.

## Current State

### Circuit Computation

The ZKP circuit currently computes the new root using a simplified formula:
```
new_root = poseidon(old_root, nullifiers)
```

This is a simplified computation that doesn't match the actual Merkle tree structure.

### Tree Computation

The on-chain commitment tree computes the actual Merkle root by:
1. Inserting new commitments into the tree at specific indices
2. Computing parent nodes by hashing child pairs
3. Propagating changes up the tree to the root
4. Using SHA-256 for hashing (not Poseidon)

### Current Validation

Due to this mismatch, the on-chain validation uses multiple layers:
1. Validate that `proof.new_root` matches `args.new_root` (from proof generation)
2. Compute the actual tree root after inserting commitments
3. Validate that the computed tree root matches the stored `current_root`
4. Allow a tolerance for root drift during migration

This multi-layer validation is necessary because the circuit's `new_root` doesn't directly correspond to the tree's root.

## Required Changes

### Circuit Updates (External)

The circuit must be updated to:
1. Compute the new root using the same algorithm as the on-chain tree
2. Use SHA-256 for hashing (matching the tree's hash function)
3. Include the actual tree path and sibling hashes in the proof
4. Compute the root by following the actual Merkle tree structure

### On-Chain Changes (After Circuit Update)

Once the circuit is updated, the on-chain validation can be simplified:

1. **Direct Root Validation**: After proof verification, directly validate:
   ```rust
   require!(
       proof.new_root == tree.root,
       PoolError::RootMismatch
   );
   ```

2. **Remove Multi-Layer Validation**: The current multi-layer validation can be removed:
   - Remove `validate_root_strict` complexity
   - Remove root drift tolerance
   - Simplify `is_known_root` checks

3. **Update `validate_unshield_public_inputs`**: The function can directly compare:
   ```rust
   require!(
       fields[1] == tree.current_root,
       PoolError::RootMismatch
   );
   ```

## Migration Path

1. **Phase 1 (Current)**: Multi-layer validation with tolerance
2. **Phase 2**: Circuit update to match tree computation
3. **Phase 3**: On-chain simplification after circuit update
4. **Phase 4**: Remove migration code and tolerance

## Notes

- The current implementation includes TODO comments at lines 1680-1692 and 2026-2038 in `programs/pool/src/lib.rs`
- The `validate_root_direct` placeholder function should be implemented after the circuit update
- Root expiration enforcement should be enabled after alignment is complete

