# `ptf_verifier_groth16` Program Documentation

The `ptf_verifier_groth16` program verifies Groth16 zero-knowledge proofs produced by the off-chain proof service. It is a thin wrapper around the Solana Groth16 verification syscall.

## Program ID

- Program ID: `3aCv39mCRFH9BGJskfXqwQoWzW1ULq2yXEbEwGgKtLgg`

## Responsibilities

- Store verifying key metadata (hash, ID) exposed through PDAs.
- Offer a single CPI method `verify_groth16` that other programs call before accepting shield/unshield proofs.

## Verifying Keys

`ptf_pool` expects verifying keys to be registered during bootstrap:
- `bootstrap-private-devnet.ts` loads verifying key files from `circuits/keys/`, computes their hash/ID, and calls the factory script to register them.
- Registration outputs:
  - Verifier state PDA per circuit (shield/unshield).
  - Hash and ID persistent in pool state to prevent mismatched keys.
- **Authority Control**: Only the factory program (via its PDA) can create verifying keys, preventing unauthorized key registration. The factory's `create_verifying_key` instruction performs a CPI to the verifier's `initialize_verifying_key`.

## Instruction: `verify_groth16`

Parameters:
- `verifying_key_id: u32` – Identifier for the circuit (shield = 0, unshield = 1).
- `proof: Vec<u8>` – Groth16 proof bytes.
- `public_inputs: Vec<u8>` – Flattened public input field elements (little-endian).

Accounts:
- `verifier_state` – PDA containing verifying key data.
- `verifier_program` – `ptf_verifier_groth16` itself (for CPI).

Behaviour:
- Loads verifying key bytes from PDA data.
- On-chain (BPF/SBF) builds invoke Solana's `sol_groth16_verify` syscall directly; there is no longer a stub that can be bypassed.
- Host builds (used for unit tests) fall back to Arkworks and include regression tests that ensure tampered proofs fail.
- Returns `Ok(())` if the proof is valid; errors bubble up to the caller.
- **Security Warning**: If `groth16-dev-skip` feature is enabled, a warning is logged. This feature bypasses all proof verification and MUST NOT be used in production. CI/CD must verify production builds use `groth16-syscall`, not `groth16-dev-skip`.

## Integration with `ptf_pool`

- `ptf_pool::shield` and `ptf_pool::unshield_*` load pool state, assert verifying key metadata matches expectations (`verifying_key_program`, `verifying_key`, `verifying_key_id`, `verifying_key_hash`).
- After validating account ownership, they build a `CpiContext` and call `ptf_verifier_groth16::cpi::verify_groth16`.
- Any mismatch in verifying key ID or hash results in `PoolError::VerifierMismatch`.

## Proof Format Expectations

- Proof RPC returns canonical big-endian hex strings. The frontend’s SDK converts them to little-endian byte arrays before serialising instruction data.
- The verifying program expects flattened `public_inputs` (concatenated 32-byte field elements). `decodeProofPayload` in the SDK handles this conversion.

## Security Features

- **Dev-Skip Protection**: The program logs a warning when `groth16-dev-skip` feature is enabled. This feature bypasses all proof verification and is only intended for local development. Production deployments MUST use `groth16-syscall` feature.
- **Empty Proof/Input Validation**: The program rejects empty proofs, empty public inputs, and empty verifying keys to prevent bypasses.
- **Authority Restriction**: Only the factory program can create verifying keys, preventing unauthorized key registration.

## Build Features

- **`groth16-syscall`**: Production feature that uses Solana's native Groth16 verification syscall. Required for mainnet/testnet deployments.
- **`groth16-dev-skip`**: Development-only feature that bypasses verification for local testing. MUST NOT be used in production. The program logs a warning when this feature is enabled.

## References

- [Source: `programs/verifier-groth16/src/lib.rs`](../../programs/verifier-groth16/src/lib.rs)
- [Bootstrap script exporting verifying keys](../development/private-devnet.md#verifying-keys)

