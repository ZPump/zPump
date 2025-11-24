# Circuit-Tree Alignment Recommendation

## Executive Summary

**Recommended Approach: Migrate Tree to Poseidon**

Change the on-chain commitment tree from SHA-256 to Poseidon hashing to align with circuit computation. This provides:
- ✅ **Cost Efficiency**: Poseidon is cheap in ZK circuits (already used)
- ✅ **Alignment**: Circuit and tree use same hash function
- ✅ **Security**: Poseidon is cryptographically secure
- ✅ **Existing Infrastructure**: On-chain Poseidon implementation already exists
- ✅ **Scalability**: No increase in compute costs for unshield operations

## Current State Analysis

### On-Chain Tree (SHA-256)
- Uses `hashv` (Solana's built-in SHA-256 syscall) - very cheap on-chain
- Computes actual Merkle tree structure with proper paths
- Functions: `sha_leaf()` and `sha_branch()` use `hashv`

### Circuits (Poseidon)
- Uses Poseidon for commitments (cheap in ZK)
- Uses simplified root computation: `poseidon(old_root, nullifiers)` 
- Doesn't match actual tree structure

### On-Chain Poseidon Implementation
- Already exists in `programs/pool/src/poseidon.rs`
- Has `hash_two(left, right)` for Merkle branches
- Has `merkle_zero(level)` for zero values
- Currently unused for tree computation

## Recommended Solution: Migrate Tree to Poseidon

### Phase 1: Update Tree to Use Poseidon

**Changes to `programs/pool/src/lib.rs`:**

1. **Replace `sha_leaf` with Poseidon:**
```rust
use poseidon::{hash_two, merkle_zero};

fn poseidon_leaf(commitment: &[u8; 32]) -> Fr {
    // Convert commitment bytes to Fr
    // Hash with Poseidon
    // Return Fr (can be converted to [u8; 32] for storage)
}

fn poseidon_branch(left: &Fr, right: &Fr) -> Fr {
    hash_two(left, right)
}
```

2. **Update `CommitmentTree` to store roots as `Fr` or convert:**
   - Option A: Store as `[u8; 32]` (convert Fr to bytes)
   - Option B: Store as `Fr` directly (requires account layout change)

3. **Update `append_many` and `insert_leaf` to use Poseidon:**
   - Replace `sha_leaf()` calls with `poseidon_leaf()`
   - Replace `sha_branch()` calls with `poseidon_branch()`
   - Update zero values to use `merkle_zero(level)`

### Phase 2: Update Circuits to Compute Actual Merkle Root

**Changes to circuits:**

1. **Transfer Circuit (`circuits/transfer/circuit.circom`):**
   - Instead of: `new_root = Poseidon(old_root, nullifier_0, nullifier_1)`
   - Compute: Actual Merkle root by:
     - Proving knowledge of Merkle path for nullified notes
     - Computing new root after inserting output commitments
     - Following the same tree structure as on-chain

2. **Unshield Circuit (`circuits/unshield/circuit.circom`):**
   - Instead of: `new_root = Poseidon(old_root, nullifier, change_commitment, change_amount_commitment)`
   - Compute: Actual Merkle root including change commitment insertion

3. **Shield Circuit (`circuits/shield/circuit.circom`):**
   - Already closer to correct: `new_root = Poseidon(old_root, commitment_hash)`
   - Update to match tree's actual insertion path

### Phase 3: Simplify On-Chain Validation

After circuits are updated:

1. **Direct Root Validation:**
```rust
// After proof verification
require!(
    proof.new_root == tree.current_root,
    PoolError::RootMismatch
);
```

2. **Remove Multi-Layer Validation:**
   - Remove `validate_root_strict` complexity
   - Remove root drift tolerance
   - Simplify `is_known_root` checks

## Implementation Details

### Fr to Bytes Conversion

Poseidon operates on `Fr` (field elements), but we store roots as `[u8; 32]`. Need conversion:

```rust
fn fr_to_bytes(fr: &Fr) -> [u8; 32] {
    let bytes = fr.into_bigint().to_bytes_le();
    let mut result = [0u8; 32];
    result[..bytes.len().min(32)].copy_from_slice(&bytes[..bytes.len().min(32)]);
    result
}

fn bytes_to_fr(bytes: &[u8; 32]) -> Result<Fr> {
    // Convert bytes to Fr
    // Handle endianness and field modulus
}
```

### Migration Strategy

1. **Add Feature Flag:**
   - `poseidon_tree` feature flag
   - Allows gradual rollout

2. **Dual Support (Temporary):**
   - Support both SHA-256 and Poseidon trees
   - Migrate pools one at a time
   - New pools use Poseidon, old pools migrate on-demand

3. **Migration Instruction:**
   - `migrate_tree_to_poseidon` instruction
   - Recomputes all roots using Poseidon
   - Updates tree structure

## Cost Analysis

### Current Costs (SHA-256 Tree)
- Unshield: ~146k CU
- Tree operations: ~15-20k CU per operation
- SHA-256 via `hashv`: Very cheap (syscall)

### Projected Costs (Poseidon Tree)
- Unshield: ~146-150k CU (minimal increase)
- Tree operations: ~18-25k CU (Poseidon is slightly more expensive than SHA-256 syscall, but still cheap)
- **Circuit costs: REDUCED** (Poseidon is cheap in ZK)

### Net Benefit
- **ZK proof generation: Faster/cheaper** (Poseidon is optimized for ZK)
- **On-chain: Slightly more expensive** (~5-10k CU per operation)
- **Overall: Better alignment, simpler validation, lower ZK costs**

## Security Considerations

1. **Poseidon Security:**
   - Cryptographically secure hash function
   - Designed for ZK-friendly operations
   - Used in production ZK systems

2. **Migration Security:**
   - Must ensure no root collisions during migration
   - Validate all roots after migration
   - Add integrity checks

3. **Backward Compatibility:**
   - Support both hash functions during transition
   - Clear migration path for existing pools

## Alternative Approaches Considered

### Option B: Keep SHA-256, Update Circuits to SHA-256
- ❌ **Rejected**: SHA-256 is expensive in ZK circuits
- ❌ Would significantly increase proof generation time
- ❌ Would increase circuit size and verification costs

### Option C: Hybrid Approach (Poseidon commitments, SHA-256 tree)
- ❌ **Rejected**: Current approach, causes misalignment
- ❌ Requires complex multi-layer validation
- ❌ Security relies on multiple validation layers

## Recommendation Priority

**HIGH PRIORITY** - This alignment is critical for:
1. Security: Direct root validation instead of multi-layer
2. Maintainability: Simpler code, fewer edge cases
3. Cost: Lower ZK proof generation costs
4. Scalability: Better performance as usage grows

## Implementation Steps

1. ✅ **Phase 1**: Update tree to use Poseidon (on-chain)
   - Replace `sha_leaf`/`sha_branch` with Poseidon equivalents
   - Add Fr <-> bytes conversion utilities
   - Test with existing tree structure

2. ✅ **Phase 2**: Update circuits to compute actual Merkle root
   - Modify transfer circuit
   - Modify unshield circuit  
   - Modify shield circuit
   - Test proof generation

3. ✅ **Phase 3**: Simplify on-chain validation
   - Remove multi-layer validation
   - Add direct root comparison
   - Update tests

4. ✅ **Phase 4**: Migration
   - Add migration instruction
   - Migrate existing pools
   - Remove SHA-256 support

## Testing Requirements

1. **Unit Tests:**
   - Poseidon tree operations match SHA-256 tree results (for same inputs)
   - Fr conversion functions work correctly
   - Root computation matches circuit output

2. **Integration Tests:**
   - Full shield/unshield/transfer flows
   - Root validation works correctly
   - Migration path works

3. **E2E Tests:**
   - End-to-end wrap/unwrap with Poseidon tree
   - Verify compute costs stay reasonable
   - Verify proof generation is faster

## Timeline Estimate

- **Phase 1** (Tree Migration): 2-3 days
- **Phase 2** (Circuit Updates): 3-5 days (most complex)
- **Phase 3** (Validation Simplification): 1-2 days
- **Phase 4** (Migration): 1-2 days
- **Total**: ~1-2 weeks

## Notes

- The existing Poseidon implementation in `programs/pool/src/poseidon.rs` is ready to use
- Need to ensure Fr conversion handles endianness correctly
- Consider adding benchmarks to measure actual cost differences
- May need to update documentation and audit findings after completion

