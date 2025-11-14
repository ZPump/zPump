# zPump

zPump is a Solana-based privacy exchange stack. It combines multiple Anchor programs (`ptf_pool`, `ptf_factory`, `ptf_vault`, `ptf_verifier_groth16`), a Groth16 proof service, Photon indexer, and a Next.js frontend to let users shield SPL tokens into privacy-preserving notes and redeem them later.

The README focuses on high-level onboarding. Deep dives live in [`docs/`](docs/README.md).

---

## Quickstart

1. **Install dependencies**
   ```bash
   git clone https://github.com/ZPump/zPump.git
   cd zPump/web/app && npm install
   cd ../../indexer/photon && npm install
   cd ../../services/proof-rpc && npm install
   cd ../..
   ```

2. **Start the private devnet**
   ```bash
   ./scripts/start-private-devnet.sh
   npx tsx web/app/scripts/bootstrap-private-devnet.ts
   cd web/app && npm run build && cd ..
   pm2 restart ptf-proof --update-env
   pm2 restart ptf-indexer --update-env
  pm2 restart ptf-web --update-env
   ```

3. **Visit the dApp** at [http://localhost:3000/convert](http://localhost:3000/convert). Use the faucet page to mint origin tokens (e.g. USDC) and test shield/unshield flows.

> **Note:** The `ptf_pool` program now runs with all security flags enabled (`full_tree`, `note_digests`, `invariant_checks`). We replaced the on-chain Merkle tree with SHA-256 hashing and split wrap finalisation into several low-cost instructions so the entire flow fits comfortably under the 1.4 M CU limit. The legacy “lightweight” flag remains for regression testing but is no longer required for day-to-day work.

---

## Essential Docs

| Topic | Location |
|-------|----------|
| Project overview | [`docs/overview/overview.md`](docs/overview/overview.md) |
| System architecture | [`docs/architecture/system-architecture.md`](docs/architecture/system-architecture.md) |
| Smart contracts | [`docs/smart-contracts/`](docs/smart-contracts/) |
| Frontend | [`docs/frontend/overview.md`](docs/frontend/overview.md) |
| Proof RPC / Photon | [`docs/services/`](docs/services/) |
| Dev workflow | [`docs/development/`](docs/development/) |
| Operations & troubleshooting | [`docs/operations/`](docs/operations/) |
| Glossary | [`docs/reference/glossary.md`](docs/reference/glossary.md) |

Start with the overview and architecture pages, then drill into specific components.

---

## Project Structure

```
programs/               Anchor workspace (factory, vault, pool, verifier)
docs/                   Developer documentation (this replaces the old giant README)
services/proof-rpc/     Groth16 proof generation service
indexer/photon/         Photon snapshot/indexer service
web/app/                Next.js frontend + SDK
scripts/                Automation (bootstrap, wrap/unwrap smoke tests, etc.)
```

---

