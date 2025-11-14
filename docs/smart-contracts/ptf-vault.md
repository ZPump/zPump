# `ptf_vault` Program Documentation

The `ptf_vault` Anchor program holds public SPL tokens on behalf of each pool and releases them during unshield operations. Its interface is intentionally small to keep custody logic isolated from the heavier `ptf_pool` program.

## Program ID & Purpose

- Program ID: `9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh`
- Responsibilities:
  - Initialise a vault PDA and associated token account per origin mint.
  - Accept deposits while updating the vault’s book-keeping.
  - Release funds to user accounts when unshield proofs succeed.

## PDAs & Accounts

| PDA | Seeds | Description |
|-----|-------|-------------|
| Vault State | `["vault", origin_mint]` | Stores pool authority, mint, custody token account, supply totals. |

The actual SPL token account used for custody is derived by `ptf_pool`/bootstrap script and passed in as an account parameter.

## Instructions

### `initialize_vault`

Parameters:
- `origin_mint` – The SPL mint the vault will custody.
- Accounts: payer, system program, pool authority (the pool state PDA), vault state PDA.

Behaviour:
- Derives the vault PDA, sets `pool_authority`, `origin_mint`, and initialises counters.
- Does **not** create the token account; bootstrap script calls `ensureAta` to create the SPL ATA owned by the vault PDA.

### `deposit`

Called from `ptf_pool::shield`. Accounts include:
- Vault state, vault token account (owned by vault), origin mint, depositor account, depositor token ATA, token program.

Behaviour:
- Transfers `amount` from depositor ATA to vault token account via SPL Token CPI.
- Updates vault accounting (e.g. `total_deposited`).
- No ownership checks beyond what `ptf_pool` enforces before making the CPI.

### `release`

Called from `ptf_pool::unshield_to_origin`. Accounts:
- Vault state, vault token account, destination ATA, pool authority PDA, token program.

Behaviour:
- Transfers `amount` from vault token account to destination ATA, signed by the pool PDA.
- Updates vault accounting (e.g. `total_withdrawn`).

## Security Considerations

- Only the pool PDA can sign the `release` CPI (thanks to the seeds captured in `ptf_pool` instruction).
- Deposits require user signature; release requires valid Groth16 proof in the calling program.
- The vault program itself does not inspect Groth16 proofs—it trusts the caller (`ptf_pool`). Keep program IDs stable and verify on bootstrap.

## Feature Flags

- No optional features; the program is simple and compute-light.

## References

- [Source: `programs/vault/src/lib.rs`](../../programs/vault/src/lib.rs)
- [Bootstrap script usage](../development/private-devnet.md)

