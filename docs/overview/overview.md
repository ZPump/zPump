# Project Overview

zPump is a Solana-based privacy exchange stack that allows users to shield SPL tokens into privacy-preserving zTokens and later unshield them back into their public form. The system combines zero-knowledge proofs, multiple Anchor programs, an off-chain proof service, an indexer, and a Next.js frontend into a cohesive workflow that can run entirely on a local “private devnet” or against public clusters.

## High-Level Goals

- **Private value transfer:** Let users convert fungible tokens (e.g. USDC) into anonymised privacy notes (zTokens), hold them off-chain, and redeem them without leaking transaction history.
- **Composable architecture:** Keep shielding/unshielding logic in the on-chain `ptf_pool` program, with supporting programs (`ptf_factory`, `ptf_vault`, `ptf_verifier_groth16`) handling mapping, custody, and verification.
- **Developer-friendly environment:** Provide scripts, services, and documentation so engineers can bootstrap the entire stack locally, generate proofs, and iterate quickly.
- **Performance optimisations:** Stay within Solana’s 1.4 M compute unit (CU) limit per transaction. The on-chain tree now uses SHA-256 and the wrap flow is split into multiple instructions, so we can ship with all safeguards (`full_tree`, `note_digests`, `invariant_checks`) enabled by default.

## Core Components

| Layer | Component | Purpose |
|-------|-----------|---------|
| On-chain programs | [`ptf_pool`](../smart-contracts/ptf-pool.md) | Orchestrates shield/unshield instructions, enforces Merkle roots, updates note ledger, and coordinates with vault + factory. |
|  | [`ptf_vault`](../smart-contracts/ptf-vault.md) | Custodies the underlying public SPL tokens for each pool. |
|  | [`ptf_factory`](../smart-contracts/ptf-factory.md) | Maintains mint-to-pool mappings and twin-mint configuration. |
|  | [`ptf_verifier_groth16`](../smart-contracts/verifier-groth16.md) | ZK proof verification program (Groth16). |
| Off-chain services | [Proof RPC](../services/proof-rpc.md) | Generates Groth16 proofs for wrap/unwrap flows. |
|  | [Photon indexer](../services/indexer.md) | Tracks notes, roots, nullifiers, and balances for fast client queries. |
| Frontend | [Next.js dApp](../frontend/overview.md) | Provides Convert, Faucet, Wallet drawer, Vault dashboards, and the UI wrapper around the SDK. |
| Tooling | Scripts, CLI | Bootstraps devnet, performs wrap/unwrap E2E tests, exports verifying keys. |

## Current Status

- **Compute budget:** The `ptf_pool` program now runs the full security feature set. Typical CU usage on private devnet is ~115 k (`shield`), 15 k (`shield_finalize_tree`), 11 k (`shield_finalize_ledger`), 9.6 k (`shield_check_invariant`), and 146 k (`unshield_to_origin`). The legacy `lightweight` profile is still available for regression testing.
- **Local-first workflow:** `scripts/start-private-devnet.sh` + `bootstrap-private-devnet.ts` set up everything locally, including faucets, verifying keys, and commitment tree state. The README references short instructions; detailed walkthroughs live in [development/private-devnet.md](../development/private-devnet.md).
- **Proof interoperability:** The proof RPC accepts canonical big-endian hex inputs, converts them to little-endian for on-chain comparison, and is compatible with the public Groth16 verifier program.
- **Indexer-backed balances:** Shielded balances and note state are stored in Photon’s snapshot, accessible via `/api/indexer/balances/:wallet` and `/notes/mint/:mint?afterSlot=…`. Clients use view tags to fetch only relevant ciphertexts.

## Documentation Map

This document is the starting point. Follow-up guides dive deeper into each part of the codebase:

- [System Architecture](../architecture/system-architecture.md) breaks down data flows, PDAs, and execution paths.
- [Smart Contracts](../smart-contracts/) detail every instruction, account constraint, and feature flag.
- [Frontend](../frontend/overview.md) describes the Convert flow, wallet drawer, and SDK abstractions.
- [Services](../services/) cover proof generation, photon indexing, and how they integrate with the UI.
- [Developer Workflow](../development/) enumerates environment setup, scripts, CI, and testing.
- [Operations](../operations/) houses troubleshooting guides (including root drift), compute strategy, and a catalogue of common errors.

Refer to the [Glossary](../reference/glossary.md) for domain-specific terminology.

