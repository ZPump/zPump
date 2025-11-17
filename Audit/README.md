# Privacy Twin Factory – Security Audit Summary

| Rank | Severity | Contract | Finding |
| --- | --- | --- | --- |
| 1 | Critical | Pool | Private transfers accept attacker-chosen commitments that are never checked against the Groth16 proof, enabling inflation. |
| 2 | Critical | Pool | `transfer_from` only deducts the caller-provided `allowance_amount`, so delegates can drain unlimited funds while barely reducing their allowance. |
| 3 | High | Factory | Timelock entries are queued under one PDA seed tuple and executed under another, so governance actions can never execute. |
| 4 | High | Verifier | Building with the `groth16-dev-skip` feature bypasses every proof verification call, destroying the privacy pool’s soundness. |

See the per-program reports in this directory for full details, impact analysis, and remediation guidance.
