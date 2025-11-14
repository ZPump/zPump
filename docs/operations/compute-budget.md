# Compute Budget Strategy

Solana enforces a per-transaction compute budget of ~1.4 M units (CU) and a per-instruction limit of 200 k CU (configurable). zPump’s shielding/unshielding logic is heavy, so understanding and managing compute consumption is critical.

## Current Program Profile

- `ptf_pool` is the dominant consumer (Poseidon hashing, Merkle updates, invariant checks).
- `ptf_vault` and `ptf_factory` are lightweight (basic SPL token CPI).
- `ptf_verifier_groth16` cost depends on proof size but is relatively small compared to tree operations.

## SHA-Tree Full-Security Mode (Default)

We now ship `ptf_pool` with **all** security flags enabled (`full_tree`, `note_digests`, `invariant_checks`). The key optimisation was moving the on-chain Merkle tree to Solana’s SHA-256 syscall while keeping Poseidon inside the circuits. Combined with the `ShieldClaim` PDA and multi-step finalisation, the wrap flow fits comfortably inside the compute budget. Representative numbers from `wrap-unwrap-local.ts` on private devnet:

| Instruction               | CU (approx.) |
|--------------------------|--------------|
| `shield`                 | 115 k        |
| `shield_finalize_tree`   | 15 k         |
| `shield_finalize_ledger` | 11 k         |
| `shield_check_invariant` | 9.6 k        |
| `unshield_to_origin`     | 146 k        |

Even when ATA creation or hooks are involved, the combined pipeline stays well below 1.4 M CU because the tree update and invariant enforcement are split into their own transactions.

## Lightweight Mode (Legacy / Testing)

The `lightweight` feature is still available for regression testing:

- **Disabled:** `full_tree`, `note_digests`, `invariant_checks`.
- **Effect:** Trusts the proof-supplied root and skips digest/invariant maintenance—useful for bisecting regressions but no longer required for day-to-day development.
- **Compute usage:** ~1.0–1.1 M CU for the entire wrap/unwrap sequence.
- **Trade-off:** Reduced on-chain assurances; only use when explicitly investigating performance issues.

## Toolbox

- **Compute Budget Program:** Frontend SDK adds `ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })` and optional `setComputeUnitPrice`. Adjust via environment variables (`NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT`, `NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE`).
- **Address Lookup Tables (ALTs):** Used during unwrap to keep transaction size within 1232 bytes, preventing bloat that would otherwise trigger `Transaction too large`.
- **Profiling:** Use `solana logs` and `solana program dump` instrumentation to monitor compute usage (`sol_log_compute_units` was removed to save compute, but re-enable locally if needed).

## Optimization Targets

1. **Merkle Tree Updates**
   - Continue monitoring SHA-tree performance; chunk size adjustments or future SIMD intrinsics (if exposed) could reduce latency further.

2. **Note Ledger Digests**
   - Future work: explore batching SHA hashes or sampling strategies to keep `note_digests` cheap if wrap volume spikes.

3. **Invariant Checks**
   - Currently sampled based on ledger policy (`should_enforce_invariant`). Tune thresholds as liquidity grows.

4. **Groth16 Verifier**
   - Maintain lean circuits (1-in/1-out) so verification stays a small fraction of total compute.

## Monitoring Compute

- `solana logs -u localhost` shows compute consumption per instruction (`consumed XXXX of YYYY compute units`).
- In dev builds, add `sol_log_compute_units()` strategically to pinpoint hotspots (remember to remove for production to save CU).
- Track wrap/unwrap failure rates due to compute errors; keep metrics in future observability stack.

## Best Practices

- Always include compute budget adjustments early in instruction list.
- Rebuild and redeploy after toggling feature flags.
- Run `wrap-unwrap-local.ts` after modifications to ensure the sequence still fits the compute budget.
- Document any compute-affecting changes in PR summaries and update this page accordingly.

