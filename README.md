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

### Unit tests (Rust workspace)

Run the entire workspace with offline crates.io usage:

```
cargo test --offline
```

### Program-test harness (Branch A loop)

Token-CPI integration tests now live under `tests/program-test-harness`. They require the Anchor 0.32.1 toolchain to produce `.so` artifacts before running:

```
anchor build
cargo test -p program-test-harness -- --ignored
```

For convenience, use the helper script:

```
scripts/run-local-ci.sh
```

The script enforces the `anchor build` → harness flow so local CI stays in sync with the spec. It intentionally fails if the Anchor CLI is not installed.
