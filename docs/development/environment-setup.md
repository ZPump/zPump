# Development Environment Setup

Follow this guide to configure a workstation for zPump development. The instructions assume Linux/macOS; adapt paths for Windows Subsystem for Linux if needed.

## Prerequisites

### Toolchain Versions

| Tool | Recommended Version | Notes |
|------|---------------------|-------|
| Node.js | 18.x or 20.x LTS | Used for frontend, proof RPC, indexer, scripts (via `tsx`). |
| npm | 9.x+ | Ships with modern Node.js releases. |
| Rust | 1.74+ | Required for Anchor programs; install via `rustup`. |
| Anchor CLI | 0.29+ | `cargo install --git https://github.com/coral-xyz/anchor anchor-cli`. |
| Solana CLI | 1.18+ | `sh -c "$(curl -sSfL https://release.solana.com/stable/install)"`. |
| pm2 | Latest | Process manager for long-running services (`npm install -g pm2`). |
| snarkjs | Bundled | Installed as part of proof RPC dependencies. |

Check installed versions:
```bash
node --version
npm --version
rustc --version
anchor --version
solana --version
pm2 --version
```

### System Dependencies

- `build-essential`, `pkg-config`, `libssl-dev` (Linux).
- `python3` for node-gyp builds (if required).
- `git`, `curl`, `jq`.

## Repository Setup

```bash
git clone https://github.com/ZPump/zPump.git
cd zPump
```

Install JavaScript dependencies:
```bash
cd web/app
npm install
cd ../../indexer/photon
npm install
cd ../../services/proof-rpc
npm install
```

Optional: install root-level hooks or linting tools as they are introduced.

## Environment Variables

Copy `.env.example` once provided (TBD). For now configure manually:

### `web/app/.env.local`
```env
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899
NEXT_PUBLIC_PROOF_RPC_URL=/api/proof
NEXT_PUBLIC_INDEXER_URL=/api/indexer
NEXT_PUBLIC_FAUCET_MODE=local
# Optional debug
NEXT_PUBLIC_DEBUG_WRAP=true
```

### `web/app/.env`
```env
RPC_URL=http://127.0.0.1:8899
PROOF_RPC_INTERNAL_URL=http://127.0.0.1:8788/prove
INDEXER_INTERNAL_URL=http://127.0.0.1:8787
```

### `services/proof-rpc/.env`
```env
PORT=8788
RPC_URL=http://127.0.0.1:8899
GROTH16_DIR=../../circuits/keys
```

### `indexer/photon/.env`
```env
PORT=8787
ENABLE_BALANCE_API=true
```

## Solana Configuration

Set local RPC endpoint and keypair:
```bash
solana config set --url http://127.0.0.1:8899
solana config set --keypair ~/.config/solana/id.json
```

Ensure the keypair exists (`solana-keygen new` if not).

`./scripts/reset-dev-env.sh` will automatically create this keypair at `~/.config/solana/id.json` when missing and use it for smoke tests.

## Scripts & Tooling

- `scripts/start-private-devnet.sh` – launches `solana-test-validator` with correct program IDs (kills existing instances first).
- `scripts/reset-dev-env.sh` – orchestrates validator/systemd, dependency installs, bootstrap, PM2 restarts, and the wrap/unwrap smoke test.
- `web/app/scripts/bootstrap-private-devnet.ts` – initialises programs, verifying keys, mints, and writes `mints.generated.json`.
- `web/app/scripts/wrap-unwrap-local.ts` – end-to-end shield/unshield test.

Install `tsx` locally (`npm install -g tsx` or rely on project `npx tsx`).

## Process Management

### Validator via systemd

The repo ships `scripts/systemd/zpump-devnet.service`. Install it once and keep the validator running with systemd:

```bash
mkdir -p ~/.config/systemd/user
cp scripts/systemd/zpump-devnet.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zpump-devnet
systemctl --user status zpump-devnet
journalctl --user -u zpump-devnet -f   # tail validator logs
```

`./scripts/reset-dev-env.sh` automatically stops/starts this unit (and falls back to PM2 if the service is absent).

### Application processes via PM2

```bash
pm2 start ecosystem.config.js
pm2 restart ptf-web --update-env
pm2 restart ptf-indexer --update-env
pm2 restart ptf-proof --update-env
pm2 save
```

## Editor & Tooling Recommendations

- VSCode with Rust Analyzer, ESLint, Prettier, Solana (Anchor) extensions.
- Configure `rustfmt` and ESLint/Prettier to run on save.
- Use `.editorconfig` (add at repo root if not present) to standardise whitespace.

## Troubleshooting

- `anchor --version` fails: ensure `$HOME/.cargo/bin` is on PATH.
- `solana-test-validator` port in use: `pkill -f solana-test-validator`.
- Groth16 proof errors: confirm verifying key files exist in `circuits/keys`.
- Node-gyp build issues: install Python 3 and compiler toolchain matching OS.

With the environment set up, continue to [Bootstrapping the Private Devnet](private-devnet.md) for step-by-step instructions to bring all components online.

