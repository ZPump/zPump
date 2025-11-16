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

**Important:** This test uses timestamp-based unique depositIds to minimize nullifier collisions, but **requires a clean devnet state** for reliable execution. Reset the devnet before running:

```bash
# Stop validator, reset, and restart
solana-test-validator --reset
# Then run bootstrap and test
npx tsx web/app/scripts/bootstrap-private-devnet.ts
npx tsx web/app/scripts/lowlevel-e2e.ts
```

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

## Full Test Suite

The project includes a comprehensive master test script that orchestrates the entire testing pipeline:

### Master Test Script (`run-full-test-suite.sh`)

The master script runs the complete test stack in order:

1. **Reset and Bootstrap** (wipes state, resets validator, bootstraps on-chain state)
2. **Build and Deploy** (compiles and deploys all programs)
3. **Smart Contract Tests** (Anchor tests)
4. **Low-Level E2E** (direct instruction testing)
5. **High-Level E2E** (SDK-based integration testing)

**Run the full suite:**
```bash
./scripts/run-full-test-suite.sh
```

**Skip specific steps:**
```bash
SKIP_ANCHOR_TESTS=true ./scripts/run-full-test-suite.sh  # Skip Anchor tests
SKIP_BUILD_DEPLOY=true ./scripts/run-full-test-suite.sh   # Skip build/deploy
SKIP_RESET=true ./scripts/run-full-test-suite.sh          # Skip reset/bootstrap
SKIP_LOWLEVEL=true ./scripts/run-full-test-suite.sh       # Skip low-level E2E
SKIP_HIGHLEVEL=true ./scripts/run-full-test-suite.sh      # Skip high-level E2E
```

**Output:**
- Colored CLI output with progress indicators
- Comprehensive logging to `.test-logs/` directory
- Individual log files for each test phase
- Summary report at the end

### Helper Scripts

The master script uses several helper scripts that can also be run independently:

#### `build-and-deploy.sh`
Builds all Anchor programs and deploys them to the validator:
```bash
./scripts/build-and-deploy.sh
```

#### `run-anchor-tests.sh`
Runs all Anchor smart contract tests:
```bash
./scripts/run-anchor-tests.sh
```

#### `wipe-indexer.sh`
Wipes the indexer state (clears Photon snapshot):
```bash
./scripts/wipe-indexer.sh
```

#### `reset-dev-env.sh`
Full reset of devnet environment (validator, indexer, bootstrap):
```bash
./scripts/reset-dev-env.sh
```

## Suggested CI Workflow

While full CI automation is still pending, the following steps are recommended before merging:

1. **Static checks**
   - `npm run lint` (frontend).
   - `npm run lint` (proof RPC & indexer when lint scripts are added).
   - `cargo fmt`, `cargo clippy` for Rust programs.

2. **Frontend tests**
   - `npm run test -- --watch=false`.

3. **Full test suite** (recommended):
   ```bash
   ./scripts/run-full-test-suite.sh
   ```
   This runs everything: smart contract tests, build/deploy, reset/bootstrap, and both E2E test suites.

4. **Manual UI verification** (quick):
   - Visit `/convert` and `/faucet`, ensure roots update after wraps and that the SDK submits the three follow-up finalize transactions (check browser console when `NEXT_PUBLIC_DEBUG_WRAP=true`).

## Test Logging

All test runs create comprehensive logs in `.test-logs/` directory:

- `test-suite.log` - Master log file with all test output
- `Anchor-Tests.log` - Anchor test output
- `Build-and-Deploy.log` - Build and deployment logs
- `Reset-and-Bootstrap.log` - Reset and bootstrap logs
- `Low-Level-E2E.log` - Low-level E2E test output
- `High-Level-E2E.log` - High-level E2E test output

These logs are useful for debugging failures and investigating issues.

## Future Enhancements

- Integrate GitHub Actions / CI pipeline that:
  - Caches dependencies.
  - Spins up `solana-test-validator` in CI container.
  - Runs `./scripts/run-full-test-suite.sh` headlessly.
  - Publishes JUnit-style results for Jest and future Rust tests.
- Add Rust integration tests covering both the default (full-security) build and the legacy `lightweight` feature gate.
- Include linting/fmt checks to enforce style automatically.
- Add test result reporting (JSON/XML output for CI integration).

## Troubleshooting Test Failures

- **Jest cannot find module:** Ensure `npm install` ran in `web/app`.
- **Wrap/unwrap script fails with root mismatch:** Reset devnet (see [private-devnet.md](private-devnet.md)) and ensure Photon snapshot is cleared.
- **Proof generation timeout:** Confirm proof RPC server is running and verifying keys exist.
- **NullifierReuse errors in lowlevel-e2e.ts:** The test uses timestamp-based unique depositIds to prevent nullifier collisions across test runs. If you see `NullifierReuse` errors, it may indicate:
  - The devnet nullifier set has accumulated nullifiers from previous test runs (reset devnet to clear)
  - The indexer has stale nullifier data (restart indexer or clear its state)
  - Clock skew causing timestamp collisions (unlikely but possible)

### Known Issues and Limitations

#### Nullifier Set Persistence and Capacity Limitation

**CRITICAL LIMITATION:** The nullifier set has a **hard limit of 256 entries** (`MAX_NULLIFIERS = 256`). This is a known critical issue (CRITICAL-001 from security audit) that affects both testnet and mainnet.

**How It Works:**
- Every time a note is spent (via `private_transfer` or `unshield`), a nullifier is added to the set
- The nullifier set is a persistent on-chain account that accumulates all used nullifiers
- Once 256 nullifiers are recorded, the pool becomes **permanently unusable**
- All future shield/unshield operations will fail with `NullifierCapacity` error
- **There is no mechanism to clear, reset, or rotate the nullifier set**

**Impact on Testnet/Mainnet:**
- **After 256 transactions that spend notes, the pool is permanently bricked**
- This is a trivial DoS attack vector (attacker can create 256 dust transactions)
- All funds in the pool become effectively locked forever
- This affects **every pool** - each pool has its own nullifier set with the same 256 limit

**Current Status:**
This is a **known critical vulnerability** documented in the security audit. The recommended fix is to replace the fixed 256-entry array with a bloom-filter-only approach (removing the capacity limit) or implement a paged structure. See `audit/ptf_pool_audit.md` and `audit/MASTER_AUDIT_REPORT.md` for details.

**For E2E Testing:**
The `lowlevel-e2e.ts` test uses timestamp-based unique depositIds (`generateUniqueDepositId()`) to minimize collisions, but if the devnet is not reset between test runs, the nullifier set will continue to grow.

**Best Practice:** Reset the devnet before running E2E tests to ensure a clean state:
```bash
# Stop validator, reset, and restart
solana-test-validator --reset
# Then run bootstrap and tests
npx tsx web/app/scripts/bootstrap-private-devnet.ts
npx tsx web/app/scripts/lowlevel-e2e.ts
```

**Note:** The test uses `generateUniqueDepositId()` which combines timestamp, counter, and random values to create unique depositIds. This minimizes collisions but does not eliminate them if the devnet has accumulated many nullifiers from previous runs. For guaranteed success, always reset the devnet before running the test.

Add more troubleshooting entries as bugs surface.

