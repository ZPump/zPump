# Proof RPC Service Documentation

The Proof RPC service (`services/proof-rpc`) generates Groth16 proofs for shield and unshield flows. It exposes HTTP endpoints consumed by the frontend (via Next.js API proxy) and the CLI scripts.

## Overview

- **Language:** TypeScript (Node.js).
- **Framework:** Fastify (through lightweight custom server).
- **Primary Responsibility:** Transform high-level wrap/unwrap payloads into Groth16 proofs (using `snarkjs`) and return canonicalised public inputs suitable for on-chain verification.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/prove/shield` | Generates a wrap proof. Payload includes old root, amount, recipient, deposit ID, pool ID, blinding, mint ID. |
| `POST` | `/prove/unshield` | Generates an unwrap proof. Payload includes note ID, spending key, change data, fee, destination, etc. |

Responses:
```json
{
  "proof": "<base64>",
  "publicInputs": ["0x...", "...", ...],
  "verifyingKeyHash": "..."
}
```

Errors translate to 4xx/5xx with descriptive messages (invalid payload, proof generation failure).

## Canonicalisation Pipeline

- **Canonical Hex Inputs:** Clients submit hex strings (with or without `0x`). Service calls `canonicalizeHex`.
- **Endian Conversion:** `canonicalHexToLeBuffer` converts canonical big-endian hex to little-endian `Buffer<32>` for on-chain comparison.
- **Public Input Serialization:** `serializePublicInputs` flattens field elements into a single little-endian buffer.
- **Amount Encoding Fixes:** `normalizeBigInt` ensures decimal strings are parsed as base 10 (fixes earlier bug where decimals were read as hex).

## Wrap Proof (`deriveShieldPublic`)

- Validates note ID (deposit ID) and blinding randomness.
- Ensures destination matches recipient public key.
- Computes `note_amount` (wrap amount).
- Returns commitments and expected root transitions for the proof circuit.

## Unwrap Proof (`deriveUnshieldPublic`)

- Accepts amount, fee, note amount (wrap amount), change outputs.
- Computes change commitments (if any), destination field, mode field (origin vs twin).
- Validates note amount ≥ amount + fee; ensures change amount is non-negative.
- Derives nullifier from noteId + spending key via Poseidon.

## Configuration

- Environment variables:
  - `RPC_URL` – Solana RPC endpoint (for validation against on-chain state, optional).
  - `CIRCUIT_DIR`, `VERIFICATION_KEY_CONFIG` – Where to load Groth16 circuits and keys.
  - `PORT` – HTTP port (defaults to 8788 when proxied by Next.js).
- Build commands:
  - `npm install`
  - `npm run build`
  - `npm start`

Next.js proxies requests via `/api/proof/...`, set `PROOF_RPC_INTERNAL_URL` to `http://127.0.0.1:8788/prove`.

## Key Source Files

- `src/server.ts` – Request handling, payload parsing, canonicalisation helpers.
- `src/derive.ts` – Logic for deriving public inputs for shield/unshield.
- `package.json` – Scripts (`build`, `export:vk`, etc.).

## Testing & Debugging

- Run locally alongside the devnet: `npm run dev`.
- Enable debug output in the frontend (`NEXT_PUBLIC_DEBUG_WRAP`) to compare expected vs actual public fields.
- If proofs fail verification:
  - Check canonicalisation (inputs must be 32-byte little-endian).
  - Ensure the verifying key hash matches the on-chain pool state (`verifying_key_hash`).

## Future Work

- Expose metrics and structured logging.
- Harden rate limiting / authentication (currently open for local development).
- Support other proof systems if circuits migrate away from Groth16.

