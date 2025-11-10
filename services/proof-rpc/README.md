# Proof RPC Service

The Proof RPC service is a stateless helper for wallets that cannot generate
Groth16 proofs locally.  It validates all inputs against the verifying keys
committed in `circuits/keys`, derives the canonical public inputs, and returns a
proof bundle that can be forwarded to the on-chain verifier program.

The implementation is intentionally conservative: if the required proving key is
missing the service refuses to start.  When actual `.zkey` files are present the
service will execute `snarkjs groth16 prove`.  Otherwise it falls back to a
Poseidon-based transcript that produces deterministic mock proofs for UI testing.

## Running locally

```bash
npm install
npm run dev
```

Environment variables:

- `PORT` (default: 8788)
- `VERIFYING_KEY_ROOT` (optional override for locating verifying keys)
- `ZKEY_ROOT` (optional path to compiled `.zkey` artifacts)
- `WASM_ROOT` (optional path to compiled witness `.wasm` artifacts)
- `INDEXER_URL` (optional Photon-compatible endpoint used to validate roots/nullifiers)
- `INDEXER_API_KEY` (bearer token when talking to the indexer)
- `PROOF_RPC_API_KEY` (shared secret required on incoming requests; header `x-ptf-api-key`)

## API

- `POST /prove/shield`
- `POST /prove/transfer`
- `POST /prove/unshield`

Each endpoint accepts the JSON payload described in
`src/routes/proof.ts` and returns `{ proof, publicInputs, verifyingKeyHash }`.

When the configured verifying key has matching `.wasm` and `.zkey` artifacts the
service invokes `snarkjs groth16 fullProve` and returns a base64 encoded proof
bundle.  Missing artifacts or prover failures automatically fall back to the
deterministic mock transcript so that developers can continue iterating without
native proving.

If `INDEXER_URL` is provided every request is first checked against the latest
root set and nullifier list to avoid generating stale proofs.  Requests that do
not match the cached state return `unknown_root` or `nullifier_reused` errors to
signal the client to refresh.
