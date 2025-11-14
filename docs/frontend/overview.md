# Frontend (Next.js) Documentation

The zPump frontend is a Next.js 14 application (`web/app`) that provides the user interface for shielding/unshielding tokens, viewing balances, and interacting with services. This document covers the major components, SDK utilities, and relevant configuration.

## Tech Stack

- **Framework:** Next.js 14 (App Router), React, TypeScript.
- **UI Library:** Chakra UI with custom theming.
- **State:** React hooks, SWR for data refetching where appropriate.
- **Wallet Integration:** Solana wallet adapter (simulation wallet for private devnet).
- **Testing:** Jest + React Testing Library (see `__tests__`).

## Key Pages & Components

### Convert Page (`/convert`)

Central UI for wrap/unwrap flows (`web/app/app/convert/page.tsx` embeds `ConvertForm`):

- `ConvertForm.tsx` handles form state, token selection, proof generation, and transaction submission.
- Modes:
  - **Public → Private** (shield): Wraps public SPL tokens into zTokens.
  - **Private → Public** (redeem): Unwraps back into public tokens (twin mint option removed for simplicity).
- Notable behaviours:
  - Fetches roots via `indexerClient.getRoots`, falls back to `fetchRootsFromChain`.
  - Automatically posts new roots to the indexer when chain data differs.
  - Uses SDK helpers `wrapSdk` and `unwrapSdk`.
  - Handles compute budget instructions and ALTs.
  - Displays proof previews when `NEXT_PUBLIC_DEBUG_WRAP=true`.

### Faucet Page (`/faucet`)

- Allows requesting SOL airdrops and minting origin tokens against the local bootstrap mint authority.
- Communicates with Next.js API routes `/api/faucet/sol` and `/api/faucet/token`.
- Recent faucet activity is backed by `faucet-events.json` in the repo (local dev only).

### Wallet Drawer (`components/wallet/WalletDrawer.tsx`)

- Displays public balances (legacy SPL + Token-2022) and shielded balances (via indexer `/balances/:wallet`).
- Uses `mintMap` to label tokens and distinguishes zTokens with `z` prefix.
- Supports manual refresh and listens to simulation wallet events.

### Layout & Navigation

- Global layout lives in `web/app/app/layout.tsx`.
- Navigation links: Home, Convert, Faucet, Vaults, Whitepaper.

## SDK (`web/app/lib/sdk.ts`)

The SDK centralises Solana transaction building and proof handling.

- `wrap(params)`:
  - Fetches commitment tree account, ensures it exists.
  - Attaches compute budget instructions (`1_400_000` CU limit by default).
  - Decodes proof payload, builds `ptf_pool::shield` instruction, optionally creates ATA.
  - Sends transaction with wallet adapter.
- `unwrap(params)`:
  - Configures ALTs (if provided), compute budget instructions.
  - Handles optional twin mint account meta (writes placeholder when unused to satisfy Anchor’s optional account constraints).
  - Passes little-endian proof bytes to `ptf_pool::unshield_to_origin`.

Other utilities:

- `decodeProofPayload` – Converts canonical hex from proof RPC into little-endian arrays.
- `waitForSignatureConfirmation` – Polls RPC until confirmation or expiration.
- `IndexerClient` – REST client for Photon (`getRoots`, `getNullifiers`, `getMintNotes`, `syncMint`, `publishRoots`, `getBalances`, `appendNullifiers`).
- `ProofClient` – Wraps Next.js API proxy for proof RPC.
- `onchain/utils.ts` – Byte/hex helpers (`canonicalizeHex`, `canonicalHexToBytesLE`, `bytesLEToCanonicalHex`).
- `onchain/commitmentTree.ts` – Binary decoding of commitment tree account data.

## Configuration

Environment variables (`.env.local`, `.env`):

- `NEXT_PUBLIC_RPC_URL` – Browser-accessible RPC endpoint (defaults to devnet cluster). On private devnet, host behind tunnel or use simulation wallet.
- `NEXT_PUBLIC_PROOF_RPC_URL` – Usually `/api/proof`.
- `NEXT_PUBLIC_INDEXER_URL` – Photon endpoint proxy (defaults to `/api/indexer`).
- `NEXT_PUBLIC_FAUCET_MODE` – `local` or `simulation`. Controls display of faucet page.
- `NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT`, `NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE` – Override compute budget instructions.
- Debug toggles: `NEXT_PUBLIC_DEBUG_WRAP`, `NEXT_PUBLIC_DEBUG_UNWRAP`.

Server-side env:

- `INDEXER_INTERNAL_URL`, `PROOF_RPC_INTERNAL_URL`, `RPC_URL` – Used by Next.js API routes to reach backend services.

## Mint Catalogue

- Generated file: `web/app/config/mints.generated.json` (created by bootstrap script).
- Consumed by `web/app/config/mints.ts` to expose `MintConfig` objects with decimals, pool ID, zToken mint, lookup table.
- UI must be rebuilt (`npm run build`) whenever the catalogue changes; otherwise the static bundle references stale accounts.

## Testing

- `__tests__/convert-form.test.tsx` – Unit tests covering form validation, proof request hooks, and account parameter expectations.
- `__tests__/roots-encoding.test.ts` – Ensures canonicalisation helpers match on-chain expectations.
- Run via `npm run test`.

## Build & Deployment

- Production build: `npm run build` (Next.js). Must be followed by `pm2 restart ptf-web --update-env` in the default process manager configuration.
- Static output served by Next.js; all dynamic interactions go through API routes which forward to local services.

## Interaction with Docs

- The README now references these documents; any major UI change should update this guide.
- For convert-specific debugging (root mismatch, nullifier issues) see [Operations > Common Errors](../operations/common-errors.md).

