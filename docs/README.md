# zPump Documentation

Welcome to the zPump developer documentation. The repository has grown beyond what a single `README.md` can comfortably cover, so this `docs/` directory collects deep-dive guides for every major subsystem.

## Table of Contents

- [Overview](overview/overview.md)
- [System Architecture](architecture/)
  - [System Architecture Overview](architecture/system-architecture.md)
  - [Program-Level Address Derivation](architecture/program-level-address-derivation.md) ⭐ **Current Architecture**
  - [Scalability Analysis](architecture/scalability-analysis.md)
  - [Lookup Table Alternatives](architecture/lookup-table-alternatives.md) (Historical)
  - [Lookup Table Scalability Proposal](architecture/lookup-table-scalability-proposal.md) (Archived)
- [On-chain Programs](smart-contracts/)
  - [`ptf_pool`](smart-contracts/ptf-pool.md)
  - [`ptf_factory`](smart-contracts/ptf-factory.md)
  - [`ptf_vault`](smart-contracts/ptf-vault.md)
  - [`ptf_verifier_groth16`](smart-contracts/verifier-groth16.md)
  - [Native zToken Minting](smart-contracts/native-ztoken-minting.md)
- [Frontend (Next.js)](frontend/overview.md)
- [Backend Services](services/)
  - [Proof RPC](services/proof-rpc.md)
  - [Photon Indexer](services/indexer.md)
- [Developer Workflow](development/)
  - [Environment Setup](development/environment-setup.md)
  - [Bootstrapping the Private Devnet](development/private-devnet.md)
  - [Continuous Integration & Testing](development/ci-testing.md)
- [Operational Playbooks](operations/)
  - [Compute Budget Strategy](operations/compute-budget.md)
  - [Troubleshooting Root Drift](operations/root-drift.md)
  - [Common Errors & Fixes](operations/common-errors.md)
- [Reference](reference/)
  - [Glossary](reference/glossary.md)

## Security

All smart contracts have been audited and security fixes have been implemented. Each program's documentation includes a "Security Features" section detailing the protections in place. Key security measures include:

- Root validation and commitment verification in `ptf_pool`
- Timelock-based governance with hash verification in `ptf_factory`
- Timelock-based authority changes in `ptf_vault`
- Verifying key authority restrictions and dev-skip protection in `ptf_verifier_groth16`

Each document is written to stand on its own, but they are cross-linked where relevant. If you are brand new to the project, start with the [Overview](overview/overview.md) and [System Architecture](architecture/system-architecture.md) pages, then dive into the specific areas you care about.

The documentation is intended to evolve with the codebase—please update or extend these guides whenever you change behaviour, add a component, or learn something new during debugging. Pull requests are welcome!

