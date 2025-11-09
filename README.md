# zPump

Early-stage Node.js and Solana development environment.

## Overview

This repository will host the codebase for the zPump project, blending a Node.js backend with Solana on-chain programs. As we define architecture and features, this document will outline project goals, setup steps, and contributor guidelines.

## Getting Started

The repository now includes a Rust workspace that models key components of the Solana Privacy Twin Factory.

## Workspace Layout

```
programs/
  common/              # shared constants and lightweight Pubkey type
  factory/             # registry logic for origin → twin mappings
  vault/               # custody controls for origin mints
  pool/                # shielded pool state machine and invariants
  verifier-groth16/    # deterministic verifier stub used in tests
docs/
  solana-privacy-twin-factory-spec-v0.5.md
```

Each crate includes unit tests that exercise invariants, feature gating, and error cases as described in the spec.

## Testing

Run the full suite without accessing the public crates index:

```
cargo test --offline
```

