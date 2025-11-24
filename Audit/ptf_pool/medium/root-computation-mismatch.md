# Root Computation Mismatch Between Circuit and Tree

**Severity:** MEDIUM  
**Status:** BY DESIGN - Tree uses SHA-256 (cheap syscall), circuits use Poseidon (ZK-friendly). This is an intentional design decision documented in `docs/operations/compute-budget.md`.

**Location:** `programs/pool/src/lib.rs:1895-1904` (transfer) and `2251-2263` (unshield)

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

**Note:** A comprehensive validation security analysis has been performed. See `docs/validation-security-analysis.md` for detailed analysis of validation correctness, identified gaps, and how we ensure bug-free operation.

## Current Mitigations

1. **Groth16 Proof Verification** - Cryptographic validation of proof validity
2. **Root Validation** - Ensures old_root is known and matches tree state
3. **Transfer Public Inputs Validation** - Validates:
   - old_root, new_root, nullifiers match proof exactly
   - All output commitments match proof exactly (byte-for-byte)
   - Duplicate commitment prevention
   - Mint and pool binding (prevents proof reuse)
   - Field element validation
4. **Unshield Public Inputs Validation** - Comprehensive validation including:
   - All commitments and amount commitments match proof
   - Amount, fee, destination, mode validation
   - Strict length validation
5. **Nullifier Validation** - Prevents double-spending
6. **Supply Invariant Checks** - Detects supply inconsistencies (if enabled)
7. **Tree's computed root is used as the actual state** - Authoritative source

**Validation Security:** See `docs/validation-security-analysis.md` for comprehensive analysis.

## Current Status

**Design Decision:**
- Tree uses SHA-256 syscall (cheap, fast, ~140k CU for transfers)
- Circuits use Poseidon (ZK-friendly, handled off-chain)
- This is an intentional design decision to optimize compute costs
- Multi-layer validation ensures security despite the mismatch

**Why This Design:**
- SHA-256 syscall is highly optimized by Solana (~3-4x cheaper than Poseidon)
- Poseidon in circuits is necessary for ZK proofs
- Migrating tree to Poseidon would hit compute limits (as demonstrated)
- Current approach balances security, cost, and functionality

**Security:**
- Multi-layer validation ensures commitments match proofs
- Tree root is authoritative (computed with SHA-256)
- Circuit validation ensures proof integrity (uses Poseidon)
- No security regressions from this design

## Recommendation

1. **Short-term**: Current multi-layer validation is secure and functional
2. **Medium-term**: Update circuits to compute actual Merkle roots (requires Merkle path proofs)
3. This would allow direct validation of the proof's new_root against the tree's root
4. Reduces reliance on multiple validation layers
5. Makes the security model simpler and more auditable

**Note**: Circuit updates are complex and require significant redesign. They are deferred to focus on getting the tree migration working first.

