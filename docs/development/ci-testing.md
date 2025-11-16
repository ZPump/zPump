# Continuous Integration & Testing

This document summarises the testing strategy, recommended checks before merging, and how to run the existing suites. As the project evolves, expand this file with new integration tests or automation scripts.

## Current Test Coverage

### Frontend (Jest)

Located in `web/app/__tests__/`:

- `convert-form.test.tsx` – Validates Convert form behaviour (form validation, proof request wiring, account meta expectations for wrap/unwrap flows). Uses Jest mocks for SDK clients.
- `roots-encoding.test.ts` – Ensures canonicalisation helpers (`canonicalizeHex`, `canonicalHexToBytesLE`, `bytesLEToCanonicalHex`) align with on-chain little-endian encodings.

Run:
```bash
cd web/app
npm run test
```

### End-to-End Scripts

The project includes two comprehensive E2E test suites:

#### High-Level E2E Test (`browser-e2e.ts`)

- `web/app/scripts/browser-e2e.ts` – Comprehensive high-level E2E test that exercises the full user flow using the SDK. Tests include:
  - Token wrapping (shield) with multi-step finalization
  - Private transfers between users
  - Transfer-from with allowance delegation
  - Unwrapping (unshield) to origin tokens
  - Governance freeze/thaw functionality
  - Nullifier set stress testing
  - Indexer integration and balance verification

Run:
```bash
npx tsx web/app/scripts/browser-e2e.ts
```

#### Low-Level E2E Test (`lowlevel-e2e.ts`)

- `web/app/scripts/lowlevel-e2e.ts` – Low-level E2E test that directly constructs and tests individual program instructions. Tests include:
  - Direct instruction construction using IDL encoder
  - Individual instruction testing (shield, shield_finalize_tree, shield_finalize_ledger, private_transfer, transfer_from, unshield_to_origin, approve_allowance, revoke_allowance, write_nullifier)
  - Edge case testing (nullifier reuse rejection, insufficient allowance rejection)
  - Account key ordering and PDA derivation validation

Run:
```bash
npx tsx web/app/scripts/lowlevel-e2e.ts
```

Both tests require:
- Validator running (local devnet)
- Proof RPC server running
- Indexer service running
- Bootstrap script executed first (`npx tsx web/app/scripts/bootstrap-private-devnet.ts`)

### On-chain Tests

Anchor unit/integration tests are not yet fleshed out (`TODO`). Plan:
```bash
anchor build -- --features full_tree,note_digests,invariant_checks
# Example placeholder - populate in future
# cargo test -p ptf-pool -- --nocapture
```

Please contribute coverage (e.g. regression tests for the SHA-tree wrap pipeline, ensuring invariant sampling behaves as expected).

## Suggested CI Workflow

While full CI automation is still pending, the following steps are recommended before merging:

1. **Static checks**
   - `npm run lint` (frontend).
   - `npm run lint` (proof RPC & indexer when lint scripts are added).
   - `cargo fmt`, `cargo clippy` for Rust programs.

2. **Frontend tests**
   - `npm run test -- --watch=false`.

3. **Bootstrap & E2E smoke test**
   - Start validator.
   - `npx tsx web/app/scripts/bootstrap-private-devnet.ts`.
   - `npx tsx web/app/scripts/browser-e2e.ts` (high-level test).
   - Optionally: `npx tsx web/app/scripts/lowlevel-e2e.ts` (low-level test).

4. **Manual UI verification** (quick):
   - Visit `/convert` and `/faucet`, ensure roots update after wraps and that the SDK submits the three follow-up finalize transactions (check browser console when `NEXT_PUBLIC_DEBUG_WRAP=true`).

## Future Enhancements

- Integrate GitHub Actions / CI pipeline that:
  - Caches dependencies.
  - Spins up `solana-test-validator` in CI container.
  - Runs bootstrap + wrap/unwrap script headlessly.
  - Publishes JUnit-style results for Jest and future Rust tests.
- Add Rust integration tests covering both the default (full-security) build and the legacy `lightweight` feature gate.
- Include linting/fmt checks to enforce style automatically.

## Troubleshooting Test Failures

- **Jest cannot find module:** Ensure `npm install` ran in `web/app`.
- **Wrap/unwrap script fails with root mismatch:** Reset devnet (see [private-devnet.md](private-devnet.md)) and ensure Photon snapshot is cleared.
- **Proof generation timeout:** Confirm proof RPC server is running and verifying keys exist.

Add more troubleshooting entries as bugs surface.

