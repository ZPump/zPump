# Privacy Twin Factory – Security Audit Summary

| # | Severity | Component | Vulnerability |
|---|----------|-----------|---------------|
| 1 | Critical | Pool | Unshield transactions never record nullifiers, so the same proof can be replayed to drain the vault indefinitely. |
| 2 | Critical | Verifier | Building with `groth16-dev-skip` makes every proof auto-approve, silently disabling ZK enforcement. |
| 3 | High | Factory | Timelock entries are derived with the wrong PDA seeds, making all queued governance actions unexecutable. |
| 4 | High | Factory | PTKN minting ignores the mapping’s frozen status, so emergency freezes do not stop twin issuance. |
| 5 | High | Pool | Allowance-based `transfer_from` never ties the claimed spend amount to the SNARK, letting an approved spender drain unlimited value. |
| 6 | Informational | Vault | Releases rely solely on the pool PDA signature; a compromised pool immediately drains the vault. |

See the per-program reports in this folder for deep dives, reproduction details, and mitigations.
