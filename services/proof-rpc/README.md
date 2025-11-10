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

## API

- `POST /prove/shield`
- `POST /prove/transfer`
- `POST /prove/unshield`

Each endpoint accepts the JSON payload described in
`src/routes/proof.ts` and returns `{ proof, publicInputs, verifyingKeyHash }`.

The mock proof encoder derives a transcript hash using Poseidon so that clients
can track deterministic proofs across retries.
