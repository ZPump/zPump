# `ptf_factory` Program Documentation

The `ptf_factory` Anchor program manages the registry of pools, origin mints, and optional twin mints used for privacy tokens. It acts as a mapping layer between public assets and their pool configuration.

## Program ID

- Program ID: `4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy`

## Responsibilities

- Register new mints and attach them to pool PDAs.
- Persist whether a privacy twin mint is enabled, and if so, track the mint address. The twin exists primarily as the bridge
  into Token-2022 Confidential Transfer (or future wrapped rails): the vault keeps custody of the origin mint while governance
  can issue a CT-capable mirror that always stays 1:1 backed.
- Provide CPI entry points to mint `ptkn` tokens during unshield operations.

## Key Accounts & PDAs

| PDA | Seeds | Description |
|-----|-------|-------------|
| Factory State | `["factory"]` | Global configuration (authority, number of pools, bump). |
| Mint Mapping | `["mint-mapping", origin_mint]` | Stores pool ID, twin mint, feature bits for each origin mint. |
| Token Metadata | `["metadata", mint]` | Stores on-chain metadata for native zTokens (name, symbol, IPFS URI). |

Fields inside `MintMapping`:
- `pool`: Pool PDA address.
- `origin_mint`: Public SPL mint for shielding.
- `ptkn_mint`: Optional twin mint (Token-2022) for privacy transfers.
- `has_ptkn: bool` – Whether `ptkn_mint` is valid.
- `features.bits` – Bit flags for future extension (currently used to expose zToken support).
- `is_native_ztoken: bool` – Currently set to `false` for all tokens (reserved for future use).

Fields inside `TokenMetadata`:
- `name: String` – Token name (max 32 bytes).
- `symbol: String` – Token symbol (max 10 bytes).
- `uri: String` – IPFS URI for full metadata (max 200 bytes).
- `mint: Pubkey` – Associated mint address.
- `update_authority: Pubkey` – Authority that can update metadata (factory PDA).
- `bump: u8` – PDA bump seed.

## Instructions

### `initialize_factory`

Sets up the factory state, authority, and bumps. Run once during bootstrap.

### `register_mint`

Called by the bootstrap script when new mints are created.
- Accounts: factory state, mint mapping PDA, pool state PDA, origin mint, optional `ptkn` mint, payer, system program.
- Sets `has_ptkn`, stores pool key, origin mint, and feature bits.

### `mint_ptkn`

Entry point used during `ptf_pool::unshield_to_ptkn`.
- Accounts: factory state, mint mapping, pool authority, `ptkn_mint`, destination ATA, token program.
- Ensures `has_ptkn` is true, `ptkn_mint` matches mapping, and signs with pool PDA seeds to mint tokens.
- No proof verification—the caller (`ptf_pool`) is responsible for verifying the Groth16 proof before invoking the CPI.

### `mint_native_ztoken`

Creates a new token mint with full metadata support. Despite the name, this creates regular Solana tokens (not special "native zTokens").
- Accounts: factory state, authority, payer, origin_mint (uninitialized), metadata (PDA), mint_mapping (PDA), pool_state (PDA), vault_state (PDA), commitment_tree (PDA), nullifier_set (PDA), note_ledger (PDA), hook_config (PDA), hook_whitelist (PDA), verifier_program, verifying_key, user_token_account, token_program, system_program, rent.
- Creates traditional SPL Token-2022 mint with factory PDA as mint authority.
- Creates metadata account with name, symbol, and IPFS URI.
- Registers mint in factory with `is_native_ztoken: false` (regular token).
- Initializes pool and vault via CPI.
- Mints initial supply to user's token account.
- User can then shield these tokens using existing shield flow.
- See [Native zToken Minting System](./native-ztoken-minting.md) for complete documentation.

## Integration Points

- `bootstrap-private-devnet.ts` ensures mint registration happens after pool initialisation. It also writes the resulting mint catalogue (`mints.generated.json`) consumed by the frontend.
- `ptf_pool::unshield_to_ptkn` caches pool state fields, drops mutable borrow, then performs a CPI into `mint_ptkn`.
- Frontend uses `mintMapping.hasPtkn` to determine whether to render the privacy twin option; currently the UI defaults to origin redeem to reduce user confusion.

## Security Features

The factory program implements several security measures:

- **Timelock Hash Verification**: When executing timelock actions, the program verifies that the action hash matches the hash computed at queue time, preventing tampering.
- **Action Deduplication**: Timelock actions are deduplicated by canonical hash (without salt) to prevent the same governance action from being queued multiple times.
- **Sequence-Based PDAs**: Timelock entries use a sequence number for PDA derivation, ensuring consistent account addressing between queue and execute operations.
- **Verifying Key Authority**: Only the factory program (via its PDA) can create verifying keys in the verifier program, preventing unauthorized key registration.
- **Minimum Timelock**: Factory initialization requires a minimum timelock period (24 hours) to prevent instant governance changes.

## Feature Flags

- The program has no optional flags; all logic always compiles.
- Feature bits in `MintMapping` currently expose:
  - `zTokenEnabled` – Whether twin mint exists.
  - `wrappedTransfers` – Reserved for future features.

## References

- [Source: `programs/factory/src/lib.rs`](../../programs/factory/src/lib.rs)
- [Bootstrap script invoking `register_mint`](../development/private-devnet.md)
- [Frontend consumption (`web/app/config/mints.ts`)](../../web/app/config/mints.ts)

