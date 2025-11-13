# Compute Optimization Plan

## Current State
- The wrap path now executes successfully, but only under a pared-down "lightweight" configuration to stay below the 1.4M compute budget.
- To fit within the current compute ceiling, we have temporarily disabled critical safety features:
  - `note_digests`: the ledger skips maintaining Merkle digests of commitments/nullifiers, preventing on-chain detection of double-spend or balance divergence.
  - `invariant_checks`: vault and twin-mint supply invariants are not asserted during shield/unshield operations, so state drift can go unnoticed.
  - `full_tree`: commitment-tree reconstruction and verification are bypassed, relying solely on the proof-supplied root and removing an important integrity check.
- These compromises mean the deployment is **not** production-ready.

## Key Bottlenecks
- Commitment-tree maintenance: updating the tree touches too many levels per instruction and concentrates work on a single transaction.
- Ledger digest hashing: Poseidon-based hashing for note ledger updates remains expensive even with lookup tables.

## Required Improvements
1. Profile the pool program to pinpoint compute hot spots, with emphasis on note ledger hashing and tree maintenance paths.
2. Optimize the on-chain routines so we can re-enable `note_digests`, `invariant_checks`, and `full_tree` without exceeding the compute budget. Potential tactics include:
   - Rewriting digest updates with leaner hashing or alternative table layouts.
   - Restructuring commitment-tree updates to touch fewer nodes per instruction or distribute work across multiple instructions.
   - Offloading or batching ledger hash computations off the critical transaction path where possible.
3. Once optimizations are in place, re-run end-to-end wrap/unwrap flows with all safeguards enabled to confirm parity with the intended production configuration.

## Next Steps
- Begin implementing and benchmarking the targeted optimizations, prioritizing the commitment-tree update path and ledger digest hashing.
- Track compute-unit usage after each change to validate progress and ensure the full security feature set can operate within the 1.4M compute limit.
