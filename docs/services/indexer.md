# Photon Indexer Documentation

The Photon indexer (`indexer/photon`) maintains an off-chain snapshot of pool state—commitment tree roots, notes, nullifiers, shielded balances, and now the authoritative mint catalog. Clients query it via REST to avoid heavy RPC scans and to hydrate the UI without coupling directly to devnet bootstrap scripts.

## Overview

- **Language:** TypeScript (Node.js, Express).
- **Storage:** JSON snapshot (`indexer/photon/data/state.json`) plus an optional Postgres catalog (`mint_catalog` table) that mirrors on-chain `MintMapping` accounts.
- **Upstream Support:** Optional chaining to a remote Photon/Helius instance; acts as cache when upstream is configured.

## Data Model (`SnapshotSchema`)

```ts
{
  roots: { [mint: string]: { current: string; recent: string[] } },
  nullifiers: { [mint: string]: string[] },
  notes: { [viewKey: string]: Note[] },
  balances: { [wallet: string]: { [mint: string]: string } }
}
```

`Note` structure:
- `commitment: string` – Canonical big-endian hex.
- `ciphertext: string` – Encrypted payload.
- `mint: string` – Origin mint (canonical hex or base58).
- `slot: number` – Slot in which note was observed.
- `viewTag?: string` – Optional short tag for client-side filtering.
- `leafIndex?: number` – Merkle leaf index (when emitted by wrap script).

All canonicalisation routes through `canonicalizeHex` and `normalizeMintKey`.

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/mints` | Returns the mint catalog hydrated from Postgres (falls back to bootstrap file if DB disabled). |
| `POST` | `/mints/sync` | Triggers an immediate on-chain sync of `MintMapping` accounts into Postgres. |
| `GET` | `/roots/:mint` | Returns current and recent roots. Falls back to upstream or errors if not found. |
| `POST` | `/roots/:mint` | Persist updated root(s). Used by frontend after wraps (`publishRoots`). |
| `GET` | `/nullifiers/:mint` | Returns nullifier array. |
| `POST` | `/nullifiers/:mint` | Append new nullifiers (client-side update after unwrap). |
| `GET` | `/notes/:viewKey` | Fetch notes by view key (legacy). |
| `GET` | `/notes/mint/:mint?afterSlot=&limit=&viewTag=` | Incremental mint-wide note query (supports pagination and view tags). |
| `GET` | `/sync/:mint?afterSlot=&limit=&viewTag=` | Combined roots/nullifiers/notes response for efficient client sync. |
| `GET` | `/balances/:wallet` | Returns shielded balances per mint. Toggle with `ENABLE_BALANCE_API`. |
| `POST` | `/balances/:wallet` | Adjust balances (delta). Used during UI shielding/unshielding. |

Responses include metadata:
- `source`: `"snapshot"`, `"cache"`, or `"upstream"`.
- `cursor`: Last slot included (for pagination).
- `hasMore`: Boolean when limit reached.

## Incremental Note Fetching

- Clients derive a short `viewTag` (e.g. 16-bit) from their view key and commitment. Pass it as a query parameter to `/notes/mint/:mint`.
- `afterSlot` allows polling from the last processed slot.
- Server sorts notes by `(slot, leafIndex)` to guarantee deterministic ordering.

## Balances API

- Enabled by default (`ENABLE_BALANCE_API=true`). When disabled, endpoints return 404 to reduce attack surface.
- `applyBalanceDelta` ensures balances don’t drop below zero and removes mint entries when they reach zero.
- Frontend uses it to display shielded totals in the wallet drawer.

## Mint Catalog Store (Postgres)

- Enabled whenever `DATABASE_URL` is provided. Photon connects to Postgres at startup, runs `schema.sql`, and creates/upserts rows inside `mint_catalog`.
- `MintCatalogStore` periodically (every 5 minutes) crawls on-chain `MintMapping` accounts, decodes them via Anchor, resolves token metadata, and stores:
  - `origin_mint`, `pool_id`, `symbol`, `decimals`
  - optional `z_token_mint`, `lookup_table`, metadata URI/name/symbol
  - feature flags (currently `has_ptkn`, `features`, fee overrides, is_native_ztoken)
- The `/mints` endpoint powers the frontend `/api/mints` handler. When Postgres is unavailable the handler falls back to the bootstrap-generated JSON file, but the catalog DB is now the source of truth.
- Force a resync after bootstrap or manual Solana changes with:

  ```bash
  curl -X POST http://127.0.0.1:8787/mints/sync
  ```

  Success responses are idempotent; failures mean RPC or DB connectivity issues.

## Canonicalisation & Validation

- `canonicalizeNote` normalises mint keys, slots, optional view tags.
- `replaceNullifiers` and `addNullifiers` run entries through `canonicalizeHex`.
- `parseOptionalNumber` safely parses `afterSlot`/`limit` query params.
- Logging leverages Pino (see `logger` usage).

## Upstream Support

- Optional environment variables:
  - `PHOTON_URL` – Remote Photon API base.
  - `PHOTON_API_KEY` – For authenticated endpoints (if required).
- When configured, `/roots` and `/nullifiers` attempt to fetch from upstream first; local snapshot acts as cache.

## Persistence

- Snapshot saved to `indexer/photon/data/state.json` on graceful shutdown (`SIGINT`, `SIGTERM`).
- Bootstrap resets should delete this file to avoid stale data (`rm -f indexer/photon/data/state.json`).
- The state store (`StateStore`) ensures canonicalisation when loading from disk.

## Running Locally

```bash
cd indexer/photon
npm install
npm run build
PORT=8787 ENABLE_BALANCE_API=true DATABASE_URL=postgres://... npm start
```

PM2 process name: `ptf-indexer`. Restart with `pm2 restart ptf-indexer --update-env`.

## Common Issues

- **`Cannot GET /mints`:** You are running an older build. Rebuild (`pnpm --filter @ptf/photon-indexer build`) and redeploy to pick up the mint catalog endpoints.
- **Catalog empty:** Ensure `DATABASE_URL` points to a reachable Postgres instance and run `POST /mints/sync`. The service logs when the upsert loop starts/completes.
- **Root mismatches:** If frontend pushes new roots but Photon still serves old ones, check file permissions on `data/state.json`, or ensure bootstrap posted the new root (frontend now publishes automatically).
- **404 `mint_not_found`:** Occurs when Photon has no entry yet. The frontend falls back to on-chain roots and repopulates the snapshot; make sure RPC access is available.
- **`invalid_hex` errors:** Caused by non-hex strings (usually base58) reaching Photon endpoints; ensure callers convert to canonical hex (SDK’s `canonicalizeHex` helper).

## References

- [Source: `indexer/photon/src/server.ts`](../../indexer/photon/src/server.ts)
- [Mint catalog store: `indexer/photon/src/db/mintCatalog.ts`](../../indexer/photon/src/db/mintCatalog.ts)
- [SDK client: `web/app/lib/indexerClient.ts`](../../web/app/lib/indexerClient.ts)
- [Wrap/unwrap script publishing roots/nullifiers](../development/private-devnet.md)

