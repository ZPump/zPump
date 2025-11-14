# Compute Budget Strategy

Solana enforces a per-transaction compute budget of ~1.4 M units (CU) and a per-instruction limit of 200 k CU (configurable). zPump’s shielding/unshielding logic is heavy, so understanding and managing compute consumption is critical.

## Current Program Profile

- `ptf_pool` is the dominant consumer (Poseidon hashing, Merkle updates, invariant checks).
- `ptf_vault` and `ptf_factory` are lightweight (basic SPL token CPI).
- `ptf_verifier_groth16` cost depends on proof size but is relatively small compared to tree operations.

## Lightweight Mode (Default)

To fit inside 1.4 M CU, the repository currently builds `ptf_pool` with the `lightweight` feature:

- **Disabled features:** `full_tree`, `note_digests`, `invariant_checks`.
- **Effect:** The program trusts the new root provided by the proof, increments `next_index`, and skips expensive recomputation of the Merkle tree and digests. Invariant checks (vault supply vs. ledger) are also skipped.
- **Compute usage:** Wrap/unwrap typically ~1.0–1.1 M CU depending on ATA creation and hook configuration.
- **Trade-off:** Reduced on-chain assurances—clients must supply valid roots; trust rests on off-chain components keeping state consistent (indexer, proof generation).

## Full Feature Mode (Work in Progress)

Building with `anchor build -- --features full_tree,note_digests,invariant_checks` re-enables all safety checks:

- **`full_tree`:** Recalculates every level of the Merkle tree, updates canopy and recent commitments.
- **`note_digests`:** Maintains Poseidon digests of note commitments and nullifiers.
- **`invariant_checks`:** Enforces vault and twin mint supply invariants after shield/unshield.

Current state: compute exceeds 1.4 M CU, so transactions fail with `ComputeUnitExceeded`. We are actively profiling hotspots and refactoring to slim them down (e.g. caching frontier values, reducing duplicate hashing, splitting instructions if necessary).

## Toolbox

- **Compute Budget Program:** Frontend SDK adds `ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })` and optional `setComputeUnitPrice`. Adjust via environment variables (`NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT`, `NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE`).
- **Address Lookup Tables (ALTs):** Used during unwrap to keep transaction size within 1232 bytes, preventing bloat that would otherwise trigger `Transaction too large`.
- **Profiling:** Use `solana logs` and `solana program dump` instrumentation to monitor compute usage (`sol_log_compute_units` was removed to save compute, but re-enable locally if needed).

## Optimization Targets

1. **Merkle Tree Updates**
   - Investigate batching Poseidon hashes with SIMD-like optimisations (within Anchor constraints).
   - Precompute zero nodes (already implemented via `MERKLE_ZEROES`).
   - Explore two-phase transaction (verify proof in one instruction, apply state change in another) to split compute cost—requires careful atomicity considerations.

2. **Note Ledger Digests**
   - Consider incremental hashing or off-chain verification.
   - Potential use of parallel instructions or asynchronous digest updates recorded via hooks.

3. **Invariant Checks**
   - Evaluate whether they can be deferred or sampled (e.g. run every N transactions).
   - Possibly move heavy arithmetic off-chain with verifiable proofs.

4. **Groth16 Verifier**
   - Ensure proof size remains minimal; investigate alternative curves/circuits if verification dominates compute.

## Monitoring Compute

- `solana logs -u localhost` shows compute consumption per instruction (`consumed XXXX of YYYY compute units`).
- In dev builds, add `sol_log_compute_units()` strategically to pinpoint hotspots (remember to remove for production to save CU).
- Track wrap/unwrap failure rates due to compute errors; keep metrics in future observability stack.

## Best Practices

- Always include compute budget adjustments early in instruction list.
- Rebuild and redeploy after toggling feature flags.
- Run `wrap-unwrap-local.ts` after modifications to ensure the sequence still fits the compute budget.
- Document any compute-affecting changes in PR summaries and update this page accordingly.

