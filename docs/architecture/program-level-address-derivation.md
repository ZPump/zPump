# Program-Level Address Derivation

## Overview

zPump uses **program-level address derivation** to eliminate the need for Address Lookup Tables (ALTs). All program-derived addresses (PDAs) are derived deterministically within the programs themselves, ensuring maximum scalability and minimal transaction overhead.

## Architecture

### Core Concept

Instead of storing addresses in lookup tables or passing them in transactions, programs derive all necessary PDAs internally from minimal inputs (typically `originMint`). The program then validates that the provided accounts match the derived addresses.

### Implementation

#### Centralized Address Derivation Module

All PDA derivation logic is centralized in `programs/common/src/addresses.rs`:

```rust
pub struct AddressDeriver;

impl AddressDeriver {
    // Pool-related PDAs
    pub fn derive_pool_state(origin_mint: &Pubkey, pool_program_id: &Pubkey) -> (Pubkey, u8);
    pub fn derive_commitment_tree(origin_mint: &Pubkey, pool_program_id: &Pubkey) -> (Pubkey, u8);
    pub fn derive_nullifier_set(origin_mint: &Pubkey, pool_program_id: &Pubkey) -> (Pubkey, u8);
    pub fn derive_note_ledger(origin_mint: &Pubkey, pool_program_id: &Pubkey) -> (Pubkey, u8);
    pub fn derive_hook_config(origin_mint: &Pubkey, pool_program_id: &Pubkey) -> (Pubkey, u8);
    pub fn derive_hook_whitelist(origin_mint: &Pubkey, pool_program_id: &Pubkey) -> (Pubkey, u8);
    pub fn derive_shield_claim(pool_state: &Pubkey, pool_program_id: &Pubkey) -> (Pubkey, u8);
    
    // Vault-related PDAs
    pub fn derive_vault_state(origin_mint: &Pubkey, vault_program_id: &Pubkey) -> (Pubkey, u8);
    
    // Factory-related PDAs
    pub fn derive_mint_mapping(origin_mint: &Pubkey, factory_program_id: &Pubkey) -> (Pubkey, u8);
    pub fn derive_factory_state(factory_program_id: &Pubkey) -> (Pubkey, u8);
    
    // Verifier-related PDAs
    pub fn derive_verifying_key(circuit_tag: &[u8; 32], version: u8, verifier_program_id: &Pubkey) -> (Pubkey, u8);
    
    // Helper: Derive all pool-related addresses
    pub fn derive_all_pool_addresses(...) -> PoolAddresses;
}
```

#### Program Instruction Pattern

All instructions follow this pattern:

```rust
pub fn shield(ctx: Context<Shield>, args: ShieldArgs) -> Result<()> {
    // 1. Derive all PDAs from origin_mint
    let origin_mint_key = ctx.accounts.origin_mint.key();
    let pool_addresses = AddressDeriver::derive_all_pool_addresses(
        &origin_mint_key,
        ctx.program_id,
        &vault_program_id,
        &factory_program_id,
        &verifier_program_id,
    );
    
    // 2. Validate provided accounts match derived addresses
    require_keys_eq!(
        ctx.accounts.pool_state.key(),
        pool_addresses.pool_state,
        PoolError::OriginMintMismatch,
    );
    require_keys_eq!(
        ctx.accounts.commitment_tree.key(),
        pool_addresses.commitment_tree,
        PoolError::CommitmentTreeMismatch,
    );
    // ... validate all other PDAs
    
    // 3. Continue with instruction logic using validated accounts
    // ...
}
```

## Benefits

### ✅ Maximum Scalability

- **No storage overhead**: No lookup tables to create, extend, or manage
- **No capacity limits**: No 256-address limit per lookup table
- **O(1) derivation**: Constant-time PDA derivation regardless of scale
- **Unlimited tokens**: System scales linearly with token count

### ✅ Simplified Architecture

- **No lookup table management**: Eliminates complexity of creating, extending, and sharing lookup tables
- **No activation delays**: No waiting for lookup table activation
- **No network calls**: All derivation is local (client-side) or on-chain (program-side)
- **Single source of truth**: Centralized derivation logic in `ptf_common`

### ✅ Transaction Efficiency

- **Minimal transaction size**: Only `originMint` + instruction data needed
- **No lookup table references**: Transactions don't need to include lookup table addresses
- **Standard transactions**: Uses regular `Transaction` instead of `VersionedTransaction`
- **Fits within limits**: Transactions well within Solana's 1232-byte limit

### ✅ Security & Validation

- **Program-enforced validation**: Programs validate all addresses match derived values
- **Deterministic**: Same inputs always produce same addresses
- **Tamper-proof**: Cannot pass incorrect addresses (program rejects them)
- **Type-safe**: Centralized derivation ensures consistency across programs

## PDA Derivation Seeds

All PDAs use deterministic seeds based on `originMint`:

| PDA | Seeds | Program |
|-----|-------|---------|
| `pool_state` | `[b"pool", origin_mint]` | `ptf_pool` |
| `commitment_tree` | `[b"tree", origin_mint]` | `ptf_pool` |
| `nullifier_set` | `[b"nulls", origin_mint]` | `ptf_pool` |
| `note_ledger` | `[b"notes", origin_mint]` | `ptf_pool` |
| `hook_config` | `[b"hooks", origin_mint]` | `ptf_pool` |
| `hook_whitelist` | `[b"whitelist", origin_mint]` | `ptf_pool` |
| `shield_claim` | `[b"claim", pool_state]` | `ptf_pool` |
| `vault_state` | `[b"vault", origin_mint]` | `ptf_vault` |
| `mint_mapping` | `[b"map", origin_mint]` | `ptf_factory` |
| `factory_state` | `[b"factory"]` | `ptf_factory` |

## Migration from Lookup Tables

The system previously used Address Lookup Tables to compress transaction sizes. This was replaced with program-level derivation for:

1. **Better scalability**: No lookup table capacity limits
2. **Simpler architecture**: No lookup table management
3. **Lower overhead**: No storage or network costs for lookup tables
4. **Maximum flexibility**: No constraints on address count

### What Changed

- **Removed**: All lookup table creation, extension, and storage logic
- **Removed**: `VersionedTransaction` usage (now uses standard `Transaction`)
- **Removed**: `lookup_table` field from `MintMapping` struct
- **Added**: `AddressDeriver` module in `ptf_common`
- **Added**: PDA derivation and validation in all program instructions

## Scalability Characteristics

### Storage

- **Per token**: Only `MintMapping` account (~81 bytes)
- **No lookup tables**: Zero additional storage per token
- **1M tokens**: ~81 MB total (vs ~5 GB with lookup tables)

### Performance

- **Derivation time**: O(1) constant time
- **Network calls**: 0 (all derivation is local)
- **Transaction size**: Minimal (~32 bytes for `originMint` + instruction data)

### Limits

- **No hard limits**: System scales to unlimited tokens
- **No capacity constraints**: No 256-address limit
- **Linear scaling**: Performance constant regardless of token count

## Implementation Details

### Client-Side (SDK)

The SDK derives addresses client-side to build transactions:

```typescript
// Derive all addresses from originMint
const poolState = derivePoolState(originMint);
const vaultState = deriveVaultState(originMint);
const commitmentTree = deriveCommitmentTree(originMint);
// ... etc

// Build transaction with derived addresses
const tx = new Transaction().add(
  createShieldInstruction({
    poolState,
    vaultState,
    commitmentTree,
    // ... other accounts
  })
);
```

### Program-Side (Rust)

Programs derive addresses internally and validate:

```rust
// Derive addresses
let pool_addresses = AddressDeriver::derive_all_pool_addresses(...);

// Validate provided accounts match
require_keys_eq!(ctx.accounts.pool_state.key(), pool_addresses.pool_state, ...);
```

## References

- [Source: `programs/common/src/addresses.rs`](../../programs/common/src/addresses.rs)
- [Pool Program Implementation](../../programs/pool/src/lib.rs)
- [Factory Program Implementation](../../programs/factory/src/lib.rs)
- [Vault Program Implementation](../../programs/vault/src/lib.rs)

