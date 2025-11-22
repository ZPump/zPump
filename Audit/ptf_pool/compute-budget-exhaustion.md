# Compute Budget Exhaustion and DoS

## Severity: MEDIUM

## Description

The pool program performs computationally expensive operations (Merkle tree updates, proof verification, etc.). While there are compute budget limits, there are potential DoS vectors through compute exhaustion or resource consumption.

## Vulnerability Details

### Current Implementation

The code includes:
- Compute budget settings: 1.4M CU limit for wrap operations
- Multi-step transactions to stay within limits
- Expensive operations: Merkle tree updates, proof verification, nullifier set operations

### Potential Vulnerabilities

1. **Nullifier Set Growth**: As nullifiers accumulate, operations become more expensive (O(log n) lookups). At maximum size (100K nullifiers), operations could approach compute limits.

2. **Merkle Tree Depth**: Deep Merkle trees require more computation. If the tree grows very large, operations could exceed compute budgets.

3. **Reallocation Costs**: Account reallocations consume compute units. If many reallocations are needed, compute could be exhausted.

4. **Proof Verification**: Large or complex proofs consume more compute. Malicious proofs could be crafted to consume maximum compute.

5. **Hook Execution**: Hooks can consume arbitrary compute. Malicious hooks could cause transactions to fail.

6. **Transaction Size**: Large transactions (many accounts, large data) consume more compute for deserialization and validation.

7. **Loop DoS**: If any loops don't have proper bounds, they could consume excessive compute.

## Exploitation Scenario

```rust
// Scenario 1: Nullifier set exhaustion
// 1. Attacker performs many operations to fill nullifier set
// 2. At maximum size (100K), lookups become expensive
// 3. Legitimate operations start failing due to compute limits
// 4. Pool becomes unusable

// Scenario 2: Merkle tree growth
// 1. Attacker performs many small shield operations
// 2. Merkle tree grows very large
// 3. Tree updates become expensive
// 4. Operations start failing

// Scenario 3: Reallocation DoS
// 1. Attacker causes many reallocations
// 2. Each reallocation consumes compute
// 3. Combined with other operations, compute limit is exceeded
// 4. Transactions fail

// Scenario 4: Malicious hook
// 1. Attacker deploys hook that consumes maximum compute
// 2. All shield/unshield operations that trigger hook fail
// 3. Pool becomes unusable
```

## Code References

- Compute budget documentation: `docs/operations/compute-budget.md`
- Nullifier set max size: `MAX_NULLIFIERS = 100_000` (line 3170)
- Reallocation logic: Lines 3210-3253
- Hook execution: Various locations in shield/unshield flows

## Mitigation

1. **Compute Budget Monitoring**: Monitor compute usage and alert when approaching limits.

2. **Nullifier Set Limits**: The code already has `MAX_NULLIFIERS` limit, which is good. Consider lowering if compute becomes an issue.

3. **Merkle Tree Optimization**: Optimize Merkle tree operations to reduce compute consumption.

4. **Hook Compute Limits**: Set maximum compute budget for hook execution to prevent DoS.

5. **Reallocation Batching**: Batch reallocations to reduce per-operation costs.

6. **Proof Size Limits**: Enforce strict limits on proof and public input sizes.

7. **Transaction Size Limits**: Limit the number of accounts and data size in transactions.

8. **Loop Bounds**: Ensure all loops have strict bounds to prevent infinite or excessive iterations.

9. **Early Exit Conditions**: Add early exit conditions for expensive operations when possible.

10. **Compute Budget Adjustment**: Allow dynamic adjustment of compute budgets based on network conditions.

## Recommended Code Changes

```rust
// Hook compute limit
const MAX_HOOK_COMPUTE: u32 = 50_000; // 50k CU for hooks

fn execute_hook_safely(
    hook_program: &Program,
    hook_accounts: &[AccountInfo],
) -> Result<()> {
    // Set compute budget for hook
    let compute_budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(MAX_HOOK_COMPUTE);
    invoke(&compute_budget_ix, &[])?;
    
    // Execute hook
    // ...
}

// Monitor compute usage
fn check_compute_remaining() -> Result<()> {
    let remaining = solana_program::compute_budget::get_remaining_compute_units();
    require!(
        remaining > MIN_REQUIRED_COMPUTE,
        PoolError::InsufficientCompute
    );
    Ok(())
}

// Optimize nullifier lookups
// Use more efficient data structures or caching for large sets
impl NullifierSet {
    // Consider using a more efficient structure for very large sets
    // e.g., Bloom filter for negative lookups, then verify with binary search
    pub fn contains_optimized(&self, value: &[u8; 32]) -> bool {
        // For very large sets, use optimized lookup
        if self.nullifiers.len() > 10_000 {
            // Use more efficient algorithm
            // ...
        } else {
            // Use binary search for smaller sets
            self.nullifiers.binary_search(value).is_ok()
        }
    }
}

// Proof size limits (already in verifier, but ensure they're strict)
const MAX_PROOF_SIZE: usize = 10 * 1024; // 10KB
const MAX_PUBLIC_INPUTS_SIZE: usize = 2 * 1024; // 2KB

// Validate before verification
require!(
    proof.len() <= MAX_PROOF_SIZE,
    PoolError::ProofTooLarge
);
require!(
    public_inputs.len() <= MAX_PUBLIC_INPUTS_SIZE,
    PoolError::PublicInputsTooLarge
);
```

