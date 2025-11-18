# Privacy Twin Factory – Security Audit Summary

| Severity | Contract | Vulnerability |
| --- | --- | --- |
| Critical | Pool | Merkle roots are not tied to the proof outputs, enabling forged commitments to be appended to the tree.【F:programs/pool/src/lib.rs†L1098-L1115】【F:programs/pool/src/lib.rs†L1395-L1413】 |
| Critical | Verifier | `groth16-dev-skip` builds accept every proof, so a misconfigured deployment forfeits all soundness guarantees.【F:programs/verifier-groth16/src/lib.rs†L87-L119】【F:programs/verifier-groth16/src/lib.rs†L243-L254】 |
| High | Pool | Output amount commitments are never compared against the proof, allowing arbitrary ciphertext inflation.【F:programs/pool/src/lib.rs†L3337-L3372】 |
| High | Pool | Allowance spending trusts attacker-supplied `spend_amount` values and never recomputes the transferred value.【F:programs/pool/src/lib.rs†L952-L980】【F:programs/pool/src/lib.rs†L2267-L2281】 |
| High | Factory | Reused PTKN mints can retain a hostile freeze authority because `prepare_ptkn_mint` never reassigns it.【F:programs/factory/src/lib.rs†L845-L903】 |
| Medium | Vault | Authority-change timelock uses a single `pending_change` PDA that cannot be cleared if execution fails, bricking upgrades.【F:programs/vault/src/lib.rs†L89-L200】【F:programs/vault/src/lib.rs†L260-L310】 |
| Medium | Factory | Timelock hash deduplication never prunes stale entries, so governance can deadlock if an entry PDA disappears.【F:programs/factory/src/lib.rs†L238-L299】【F:programs/factory/src/lib.rs†L455-L476】 |
| Medium | Verifier | `initialize_verifying_key` accepts arbitrarily large verifying keys, allowing resource-exhaustion griefing.【F:programs/verifier-groth16/src/lib.rs†L21-L85】【F:programs/verifier-groth16/src/lib.rs†L150-L190】 |

## Recommendations
1. **Patch critical zk-circuit coupling issues immediately.** Stop shielded transfers and unshields until the circuits emit the real post-output root and amount commitments as public inputs that the on-chain program enforces.
2. **Tighten build and deployment tooling.** Make dev-only features (such as `groth16-dev-skip`) impossible to compile on mainnet/testnet artifacts.
3. **Harden governance/authority workflows.** Ensure PTKN mints are fully under program control, add pruning paths for timelock hashes and vault pending changes, and enforce safe upper bounds on verifier account sizes.
