# Compute Optimization Plan

## Current State
- The wrap path now executes with **all** security features enabled (`full_tree`, `note_digests`, `invariant_checks`). This was achieved by:
  - Migrating the on-chain Merkle tree to SHA-256 leaves/branches (Poseidon remains inside the circuits).
  - Splitting wrap finalisation into `shield_finalize_tree`, `shield_finalize_ledger`, and `shield_check_invariant`, coordinated by the `ShieldClaim` PDA.
  - Sampling invariant checks via the ledger to avoid paying the cost on every wrap.
- Typical compute usage (private devnet, November 2025):
  - `shield`: ~115 k CU
  - `shield_finalize_tree`: ~15 k CU
  - `shield_finalize_ledger`: ~11 k CU
  - `shield_check_invariant`: ~9.6 k CU
  - `unshield_to_origin`: ~146 k CU

## Remaining Opportunities
- **Indexer Synchronisation** – Ensure Photon ingests the SHA roots quickly; clients currently POST the root immediately after wrap.
- **Digest Hashing** – We now hash commitments/nullifiers with SHA, but batching or streaming techniques could further reduce ledger costs when throughput spikes.
- **Invariant Policy** – Today the ledger requests an invariant check based on note value and a sampling interval. Continue tuning thresholds to balance safety and compute.
- **Proof Aggregation** – Future roadmap item: batch multiple wraps/unshields per proof to amortise Groth16 verification if demand increases.

## Next Steps
1. Monitor compute regressions: every smart-contract change should re-run `wrap-unwrap-local.ts` with full features to keep the CU profile documented.
2. Automate CU reporting in CI (parse `solana confirm` output) so PRs surface deltas immediately.
3. Investigate batch publishing of roots/nullifiers to the indexer to cut redundant HTTP calls once throughput grows.