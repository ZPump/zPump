# Native zToken Minting System

## Overview

The native zToken minting system allows users to create new zTokens that don't start from traditional Solana tokens. These tokens are minted as zTokens with full metadata support, stored on IPFS, and can be shielded/unshielded just like regular tokens.

## Architecture

### Key Design Decisions

1. **Initial Supply**: Traditional tokens are minted to the user, then the user shields them using the existing shield flow. This aligns with the standard shield/unshield pattern and requires no special logic in the pool program.

2. **Metadata Storage**: 
   - Essential fields (name, symbol) stored on-chain in `TokenMetadata` account
   - Full metadata (description, image) stored on IPFS
   - Follows Metaplex Token Metadata standard

3. **Traditional Counterpart**: 
   - Created with 0 initial supply
   - Factory PDA is mint authority (can mint tokens)
   - No freeze authority (prevents account freezing attacks)
   - Tokens are minted to user during native zToken creation

4. **Shield/Unshield Flow**: Works identically to regular tokens - no special logic needed. The `is_native_ztoken` flag is informational only.

## Smart Contract Implementation

### Factory Program

#### TokenMetadata Account

```rust
#[account]
pub struct TokenMetadata {
    pub name: String,           // Max 32 bytes
    pub symbol: String,          // Max 10 bytes
    pub uri: String,            // Max 200 bytes (IPFS CID)
    pub mint: Pubkey,
    pub update_authority: Pubkey,
    pub bump: u8,
}
```

**PDA Seeds**: `[b"metadata", mint.key().as_ref()]`

**Space**: ~323 bytes (discriminator[8] + name[4+32] + symbol[4+10] + uri[4+200] + mint[32] + update_authority[32] + bump[1])

#### MintMapping Updates

Added `is_native_ztoken: bool` field to `MintMapping`:
- Set to `true` for native zTokens
- Set to `false` for all existing mints (backward compatible)
- Informational only (for frontend/metadata purposes)

#### mint_native_ztoken Instruction

**Signature**:
```rust
pub fn mint_native_ztoken(
    ctx: Context<MintNativeZToken>,
    name: String,
    symbol: String,
    uri: String,              // IPFS URI (e.g., "ipfs://Qm...")
    decimals: u8,
    initial_supply: u64,
    feature_flags: Option<u8>,
    fee_bps_override: Option<u16>,
) -> Result<()>
```

**Input Validation**:
- `name`: 1-32 bytes, trimmed
- `symbol`: 1-10 bytes, uppercase, alphanumeric
- `uri`: Valid IPFS URI format (starts with "ipfs://" or CID format)
- `decimals`: 0-9
- `initial_supply`: > 0, <= MAX_SUPPLY
- `fee_bps_override`: If Some, must be <= 1000 (10%)

**Accounts**:
- `factory_state` - Factory state account
- `authority` - Factory authority (signer)
- `payer` - Payer for account creation (signer)
- `origin_mint` - Traditional SPL mint to create (uninitialized, signer)
- `metadata` - Token metadata account (PDA, will be initialized)
- `mint_mapping` - Mint mapping account (PDA, will be initialized)
- `factory_config` - Optional factory config account
- `pool_program` - Pool program account
- `vault_program` - Vault program account
- `pool_state` - Pool state account (PDA, will be initialized by pool program)
- `vault_state` - Vault state account (PDA, will be initialized by vault program)
- `commitment_tree` - Commitment tree account (PDA)
- `nullifier_set` - Nullifier set account (PDA)
- `note_ledger` - Note ledger account (PDA)
- `hook_config` - Hook config account (PDA)
- `hook_whitelist` - Hook whitelist account (PDA)
- `verifier_program` - Verifier program account
- `verifying_key` - Verifying key account
- `user_token_account` - User's token account (will receive minted tokens)
- `token_program` - Token program interface
- `system_program` - System program
- `rent` - Rent sysvar

**Logic Flow**:
1. Validate factory not paused
2. Validate all inputs (name, symbol length, decimals, initial_supply, URI format)
3. Create traditional SPL Token-2022 mint with:
   - 0 initial supply
   - Factory PDA as mint authority
   - No freeze authority (None)
   - Decimals as specified
4. Create metadata account (PDA) with name, symbol, URI, mint, update_authority (factory)
5. Register mint in factory:
   - Set `is_native_ztoken: true` in MintMapping
   - Set other fields as normal
6. Initialize pool via `invoke_signed`:
   - Call pool's `initialize_pool` with fee_bps and features
   - Pool will initialize commitment_tree, nullifier_set, note_ledger, hook_config, hook_whitelist
7. Initialize vault via `invoke_signed`:
   - Call vault's `initialize_vault` with pool_authority (pool PDA)
   - Vault will create vault_state and associated token account
8. Mint initial supply to user:
   - Mint `initial_supply` traditional tokens directly to user's token account
   - User can then shield these tokens using existing shield flow

**Error Codes**:
- `NativeZTokenAlreadyExists` - Mint already registered as native zToken
- `InvalidMetadataURI` - IPFS URI format invalid
- `MetadataTooLong` - Metadata fields exceed limits
- `InvalidAmount` - Initial supply must be > 0

### Pool Program

**No changes needed** - shield/unshield work identically for native zTokens. The `is_native_ztoken` flag is informational only.

## Frontend Implementation

### Minting Page

**Route**: `/mint-ztoken`

**Components**:
- `MintZTokenForm` - Form component with:
  - Token Name (text input, required, max 32 chars)
  - Token Symbol (text input, required, max 10 chars, uppercase)
  - Description (textarea, optional, for IPFS metadata)
  - Image Upload (file input, optional, max 5MB, formats: PNG/JPG/WebP)
  - Decimals (number input, 0-9, default 6)
  - Initial Supply (number input, required, > 0)
  - Fee Override (optional, 0-10%)

**Flow**:
1. User fills out form
2. Upload image to IPFS (if provided) → get image CID
3. Create metadata JSON following Metaplex standard
4. Upload metadata JSON to IPFS → get metadata CID
5. Format as "ipfs://<metadata_cid>" for on-chain URI
6. Build `mint_native_ztoken` instruction
7. Send transaction
8. Display success with mint address, pool address, vault address, metadata account address, IPFS links

### SDK Functions

#### mintNativeZToken

```typescript
export interface MintNativeZTokenResult {
  signature: string;
  originMint: string;
  poolId: string;
  metadataAccount: string;
  mintMapping: string;
  decimals: number;
  symbol: string;
  uri: string;
}

export async function mintNativeZToken(
  params: MintNativeZTokenParams
): Promise<MintNativeZTokenResult>
```

**Parameters**:
- `connection: Connection`
- `wallet: WalletContextState`
- `name: string`
- `symbol: string`
- `uri: string` (IPFS URI)
- `decimals: number`
- `initialSupply: bigint | number | string`
- `featureFlags?: number`
- `feeBpsOverride?: number`

**Returns**: Transaction signature plus the derived addresses for the origin mint, pool, metadata, and mint mapping so the frontend can immediately surface the asset in Convert/Wallet drawers.

#### getTokenMetadata

```typescript
export async function getTokenMetadata(connection: Connection, mint: PublicKey): Promise<{ name: string; symbol: string; uri: string } | null>
```

**Returns**: Token metadata from on-chain account, or `null` if not found

### IPFS Integration

**Module**: `web/app/lib/ipfs.ts`

**Functions**:
- `uploadToIPFS(data: Buffer | string, contentType?: string): Promise<string>` - Upload data and return CID
- `uploadMetadata(metadata: TokenMetadata): Promise<string>` - Upload token metadata JSON
- `uploadImage(file: File): Promise<string>` - Upload image file
- `getIPFSURL(cid: string): string` - Get IPFS gateway URL
- `createTokenMetadata(params)`: Helper to create Metaplex-standard metadata JSON

**Configuration**:
- API URL: `process.env.NEXT_PUBLIC_IPFS_API_URL || 'http://localhost:5001'`
- Gateway URL: `process.env.NEXT_PUBLIC_IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs'`

### Integration Updates

#### MintConfig

Added fields:
- `isNativeZToken?: boolean` - Flag indicating if this is a native zToken
- `metadataUri?: string` - IPFS URI for full metadata

#### WalletDrawer

- Fetches and caches metadata for native zTokens
- Displays metadata (name, symbol, image from IPFS) for native zTokens
- Shows both public and private balances for native zTokens

#### ConvertForm

- Works identically for native zTokens (no changes needed)
- Shield/unshield flow works the same way

## Testing

### E2E Tests

**File**: `web/app/scripts/lowlevel-e2e.ts`

**Test**: `test-13: Native zToken minting, shielding, and unshielding`

**Steps**:
1. Mint native zToken with metadata
2. Verify mint created
3. Verify metadata account created
4. Verify pool initialized
5. Verify vault initialized
6. Verify initial supply minted to user's token account
7. Shield the tokens using existing shield flow
8. Verify tokens deposited to vault
9. Verify private notes created
10. Verify commitment tree updated
11. Unshield the tokens
12. Verify tokens released from vault to user
13. Verify private notes nullified
14. Verify works identically to regular token unshield

## Security Considerations

1. **Access Control**: Only factory authority can mint native zTokens
2. **Input Validation**: All inputs validated (name, symbol length, decimals, initial_supply, URI format)
3. **Overflow Protection**: Uses checked arithmetic for amounts
4. **Account Validation**: Validates all accounts (ownership, PDAs, data integrity)
5. **IPFS CID Validation**: Format checking, length limits, character validation
6. **Mint Authority**: Factory PDA is mint authority, can mint tokens on demand
7. **No Freeze Authority**: Prevents account freezing attacks

## Usage Flow

1. **Minting**:
   - User navigates to `/mint-ztoken`
   - Fills out form (name, symbol, description, image, decimals, supply)
   - Uploads metadata to IPFS
   - Submits transaction
   - Receives traditional tokens in their wallet

2. **Shielding**:
   - User navigates to `/convert`
   - Selects the native zToken
   - Uses existing shield flow (works identically to regular tokens)
   - Tokens are deposited to vault
   - Private notes are created

3. **Unshielding**:
   - User navigates to `/convert`
   - Selects the native zToken
   - Uses existing unshield flow (works identically to regular tokens)
   - Tokens are released from vault
   - Private notes are nullified

## Metadata Format

Following Metaplex Token Metadata standard:

```json
{
  "name": "Token Name",
  "symbol": "SYMBOL",
  "description": "Token description",
  "image": "ipfs://<image_cid>",
  "attributes": [],
  "properties": {
    "files": [{"uri": "ipfs://<image_cid>", "type": "image/png"}]
  }
}
```

## IPFS Setup

IPFS should be installed and running on the VM:
- API endpoint: `http://localhost:5001`
- Gateway endpoint: `http://127.0.0.1:8080/ipfs/` (or public gateway)

**Installation**:
```bash
wget https://dist.ipfs.io/go-ipfs/v0.24.0/go-ipfs_v0.24.0_linux-amd64.tar.gz
tar -xvzf go-ipfs_v0.24.0_linux-amd64.tar.gz
sudo mv go-ipfs/ipfs /usr/local/bin/
ipfs init
ipfs daemon --enable-pubsub-experiment &
```

## Future Enhancements

1. **Metadata Updates**: Allow update_authority to update metadata
2. **Batch Minting**: Support minting multiple native zTokens in one transaction
3. **Metadata Caching**: Cache IPFS metadata in frontend for faster loading
4. **Image Optimization**: Automatic image resizing/optimization before IPFS upload
5. **Metadata Validation**: Enhanced validation for IPFS CIDs and metadata format

