# Glossary

A quick reference for terminology used throughout the zPump project.

| Term | Definition |
|------|------------|
| **ALT (Address Lookup Table)** | Solana feature that stores addresses off-transaction, allowing shorter transaction account lists. Used to keep unwrap transactions under the size limit. |
| **Anchor** | Framework for Solana smart contract development. Provides IDL, account validation, and CPI conveniences. |
| **Canopy** | Portion of a Merkle tree (upper levels) stored to accelerate proof verification. Our commitment tree stores up to 16 levels in the canopy. |
| **Commitment** | Poseidon hash representing a shielded note. Stored in the commitment tree and note ledger. |
| **Commitment Tree** | Merkle tree tracking note commitments. Each pool has its own tree PDA. |
| **Compute Units (CU)** | Measure of computational cost on Solana. Transactions are limited to ~1.4 M CU. The latest `ptf_pool` build (with full security features) stays well below this ceiling by splitting wrap finalisation across multiple instructions. |
| **Groth16** | Zero-knowledge proof system used for shield/unshield circuits. Verified on-chain via `ptf_verifier_groth16`. |
| **Hook** | Optional post-shield/post-unshield callbacks configured per pool. Controlled via `hook_config` PDA, enable toggles, and feature flags. |
| **Index er (Photon)** | Off-chain service that tracks roots, nullifiers, notes, and shielded balances for efficient querying. |
| **Lightweight Mode** | Legacy build profile of `ptf_pool` that disables `full_tree`, `note_digests`, and `invariant_checks`. Kept for regression testing; the default build now uses all safeguards. |
| **ShieldClaim** | PDA (`["claim", pool_state]`) that tracks the multi-step wrap finalisation pipeline (`shield_finalize_tree`, `shield_finalize_ledger`, `shield_check_invariant`). |
| **Mint Catalogue** | Generated JSON (`web/app/config/mints.generated.json`) listing origin mints, pool IDs, twin mints, lookup tables. |
| **Nullifier** | Poseidon hash proving a note has been spent. Stored in the nullifier set PDA and photon snapshot. |
| **Photon** | Code name for the indexer service. Manages snapshot file `indexer/photon/data/state.json`. |
| **Pool State** | PDA storing configuration and current root for a mint/pool pair. |
| **Proof RPC** | Service generating Groth16 proofs, canonicalising inputs, and returning base64 proof + public inputs. |
| **ptkn (Privacy Token)** | Optional twin mint representing shielded liquidity in public form. Minted by `ptf_factory::mint_ptkn`. |
| **Shield / Wrap** | Converting public tokens into private zTokens (deposit into vault, append commitment). |
| **Twin Mint** | Token-2022 mint representing privacy twin; optional depending on pool configuration. |
| **Unshield / Unwrap** | Converting zTokens back into public tokens (release from vault or mint ptkn). |
| **View Tag** | Short identifier derived from view key + commitment to filter notes without downloading all ciphertexts. |
| **zToken** | Shielded representation of an SPL token; balance tracked off-chain via notes. |

