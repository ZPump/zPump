# Fix 01: Root Mismatch Only Logged (CRITICAL)

## Problem Description

### Location
- **Contract**: `ptf_pool`
- **File**: `programs/pool/src/lib.rs`
- **Lines**: 953-960, 1226-1233

### Current Behavior
When executing private transfers or unshield operations, the code computes a new Merkle root from the commitment tree and compares it to the root provided in the zero-knowledge proof's public inputs. However, if these roots don't match, the code only logs a warning message and continues execution with the computed root instead of rejecting the transaction.

### Code Snippet (Current - Broken)
```rust
let (new_root, _output_indices) = {
    let mut commitment_tree = commitment_tree_loader.load_mut()?;
    commitment_tree.append_many(
        args.output_commitments.as_slice(),
        args.output_amount_commitments.as_slice(),
    )?
};
if new_root != args.new_root {
    msg!(
        "unshield proof new root ({}) differs from computed root ({})",
        hex::encode(args.new_root),
        hex::encode(new_root)
    );
}
pool_state.push_root(new_root);  // ⚠️ Uses computed root even if mismatch!
```

### Why This Is Critical

1. **ZK Proof Security Guarantee Violation**: Zero-knowledge proofs mathematically guarantee that the public inputs (including `new_root`) are correct. If the proof says the new root is X, but we compute Y, then either:
   - The proof is invalid (should be rejected)
   - Our computation is wrong (should be fixed)
   - There's a fundamental mismatch in the protocol

2. **Tree State Manipulation**: By accepting a computed root that doesn't match the proof, we're allowing the on-chain state to diverge from what the proof claims. This breaks the integrity of the Merkle tree.

3. **Double-Spending Risk**: If an attacker can cause a root mismatch and have it accepted, they could potentially:
   - Create invalid tree states
   - Bypass proof verification
   - Enable double-spending attacks

4. **Privacy Guarantee Breakdown**: The entire privacy model relies on the Merkle tree being consistent with the proofs. Mismatched roots break this guarantee.

### Attack Scenario

1. Attacker crafts a proof with `new_root = A`
2. On-chain computation produces `new_root = B` (due to bug, manipulation, or invalid proof)
3. Current code logs warning but accepts `B`
4. Tree state now has root `B` but proof claimed `A`
5. Future operations may fail or allow invalid states
6. Attacker could potentially exploit this inconsistency

## Solution

### Fix Strategy
**Reject the transaction immediately if roots don't match.** The proof's public inputs are the source of truth - if our computation doesn't match, we must reject.

### Implementation

#### Step 1: Update `execute_private_transfer` function

**Location**: `programs/pool/src/lib.rs` around line 946

**Change**:
```rust
let (new_root, _output_indices) = {
    let mut commitment_tree = commitment_tree_loader.load_mut()?;
    commitment_tree.append_many(
        args.output_commitments.as_slice(),
        args.output_amount_commitments.as_slice(),
    )?
};

// CRITICAL FIX: Reject if roots don't match
require!(
    new_root == args.new_root,
    PoolError::RootMismatch
);

pool_state.push_root(new_root);
```

#### Step 2: Update `process_unshield` function

**Location**: `programs/pool/src/lib.rs` around line 1226

**Change**:
```rust
#[cfg(not(feature = "lightweight"))]
{
    let (new_root, _output_indices) = {
        let mut commitment_tree = commitment_tree_loader_ref.load_mut()?;
        commitment_tree.append_many(
            args.output_commitments.as_slice(),
            args.output_amount_commitments.as_slice(),
        )?
    };
    
    // CRITICAL FIX: Reject if roots don't match
    require!(
        new_root == args.new_root,
        PoolError::RootMismatch
    );
    
    pool_state.push_root(new_root);
    // ... rest of function
}
```

#### Step 3: Ensure Error Type Exists

**Location**: `programs/pool/src/lib.rs` in error enum

Verify that `PoolError::RootMismatch` exists. If not, add it:

```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("E_ROOT_MISMATCH")]
    RootMismatch,
    // ... other errors ...
}
```

### Testing

#### Test Case 1: Valid Proof (Should Pass)
```rust
#[test]
fn test_valid_proof_root_matches() {
    // Setup: Create valid proof where computed root matches proof root
    // Expected: Transaction succeeds
}
```

#### Test Case 2: Invalid Proof (Should Reject)
```rust
#[test]
fn test_invalid_proof_root_mismatch() {
    // Setup: Create proof where computed root != proof root
    // Expected: Transaction fails with RootMismatch error
}
```

#### Test Case 3: Edge Cases
```rust
#[test]
fn test_root_mismatch_edge_cases() {
    // Test with:
    // - Empty commitments
    // - Single commitment
    // - Maximum commitments
    // - Malformed root bytes
}
```

### Verification Checklist

- [ ] Root mismatch check added to `execute_private_transfer`
- [ ] Root mismatch check added to `process_unshield`
- [ ] `PoolError::RootMismatch` error type exists
- [ ] All tests pass
- [ ] Warning message removed (or kept only for debugging)
- [ ] Code review completed
- [ ] Integration tests verify fix works end-to-end

### Additional Considerations

1. **Logging**: Consider keeping the log message for debugging, but only after the check passes:
   ```rust
   require!(new_root == args.new_root, PoolError::RootMismatch);
   msg!("Root verified: {}", hex::encode(new_root));
   ```

2. **Monitoring**: Add off-chain monitoring to alert if root mismatches are attempted (indicates potential attacks or bugs)

3. **Documentation**: Update protocol documentation to clarify that root mismatch is a hard failure

### Impact Assessment

**Before Fix**: 
- Security: CRITICAL vulnerability
- Risk: Protocol compromise, double-spending possible

**After Fix**:
- Security: Proper ZK proof validation
- Risk: None (as designed)
- Breaking Change: Yes - transactions that previously "succeeded" with warnings will now fail

### Rollout Plan

1. Deploy fix to testnet
2. Run comprehensive test suite
3. Monitor for any legitimate transactions that fail (indicates other bugs)
4. Deploy to mainnet after verification
5. Monitor for attempted root mismatches (security signal)

---

**Priority**: CRITICAL - Fix immediately before production
**Estimated Effort**: Low (simple require! check)
**Risk of Fix**: Low (makes code more secure)

