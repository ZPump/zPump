# Photon Indexer Harness

This package bootstraps a minimal Photon-compatible indexer that mirrors the
endpoints required by the Privacy Twin Factory spec.  It ingests Solana
transactions, persists compressed state to Postgres, and exposes an
Express-based API for wallets.

The implementation deliberately ships with an in-memory fallback so that local
developers can run the service without Postgres while still exercising the HTTP
surface area.

## Quick start

```bash
npm install
npm run dev
```

Environment variables:

- `RPC_URL` – Solana RPC endpoint used for block ingestion (defaults to devnet)
- `DATABASE_URL` – Postgres connection string.  If omitted the service runs in
  memory and periodically snapshots to `data/state.json`.
- `PORT` – HTTP port (default: 8787)

The service exposes three endpoints aligned with §5.1 of the specification:

- `GET /roots/:mint` – returns the current and recent roots
- `GET /notes/:viewKey` – returns encrypted payloads keyed by the supplied view key
- `GET /nullifiers/:mint` – lists spent nullifiers for fast pre-checks

## Photon compatibility

When `DATABASE_URL` points to a Photon instance the indexer simply proxies the
responses, normalising them into the canonical API shape.  This makes it easy to
swap between local snapshots and managed infrastructure with no code changes.

## Data files

The repository includes `data/fixture-state.json` with a deterministic snapshot
that powers integration tests.  Running the service in memory will automatically
update `data/state.json`; commit changes if you intentionally modify the
fixtures.

## Linting

```
npm run lint
```

Prettier can be invoked via `npm run format`.
