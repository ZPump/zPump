# Alternatives to Address Lookup Tables

## Current Situation

Looking at what's in our lookup tables, **most addresses can already be derived deterministically!**

### Addresses Currently in Lookup Tables

```typescript
const allAddresses = [
  poolState,              // ✅ PDA - can derive from originMint
  hookConfig,             // ✅ PDA - can derive from originMint
  hookWhitelist,          // ✅ PDA - can derive from originMint
  nullifierSet,           // ✅ PDA - can derive from originMint
  commitmentTreeKey,      // ✅ PDA - can derive from originMint
  noteLedger,             // ✅ PDA - can derive from originMint
  vaultState,             // ✅ PDA - can derive from originMint
  vaultTokenAccount,      // ⚠️ Token account - can derive if we know vaultState
  depositorTokenAccount,  // ⚠️ Token account - depends on user wallet
  VERIFIER_PROGRAM_ID,    // ✅ Constant - known program ID
  verifyingKey,           // ✅ PDA - can derive deterministically
  shieldClaim,            // ✅ PDA - can derive from poolState
  wallet.publicKey!,      // ❌ Variable - user's wallet address
  originMintKey,          // ✅ Known - passed as parameter
  mintMappingKey,         // ✅ PDA - can derive from originMint
  VAULT_PROGRAM_ID,       // ✅ Constant
  TOKEN_PROGRAM_ID,       // ✅ Constant
  SystemProgram.programId,// ✅ Constant
  SYSVAR_RENT_PUBKEY      // ✅ Constant sysvar
];
```

**Breakdown:**
- ✅ **15/19 addresses (79%)** can be derived deterministically
- ⚠️ **2/19 addresses (10.5%)** can be derived if we have wallet
- ❌ **2/19 addresses (10.5%)** are variable (user wallet, depositor token account)

## Option 1: Full PDA Derivation (No Lookup Tables)

### Concept

Instead of storing addresses in a lookup table, derive them all on-demand using PDAs and constants.

### Implementation

```typescript
// Derive all addresses from originMint + wallet
function deriveAllAddresses(originMint: PublicKey, wallet: PublicKey) {
  return {
    poolState: derivePoolState(originMint),
    hookConfig: deriveHookConfig(originMint),
    hookWhitelist: deriveHookWhitelist(originMint),
    nullifierSet: deriveNullifierSet(originMint),
    commitmentTree: deriveCommitmentTree(originMint),
    noteLedger: deriveNoteLedger(originMint),
    vaultState: deriveVaultState(originMint),
    vaultTokenAccount: getAssociatedTokenAddress(
      originMint, 
      deriveVaultState(originMint), 
      true
    ),
    depositorTokenAccount: getAssociatedTokenAddress(
      originMint,
      wallet,
      false
    ),
    verifyingKey: deriveVerifyingKey(),
    shieldClaim: deriveShieldClaim(derivePoolState(originMint)),
    mintMapping: deriveMintMapping(originMint),
    // Constants
    verifierProgram: VERIFIER_PROGRAM_ID,
    vaultProgram: VAULT_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rentSysvar: SYSVAR_RENT_PUBKEY,
  };
}
```

### Pros

- ✅ **No lookup table needed** - zero on-chain storage
- ✅ **No network calls** - all derivation is local
- ✅ **Fully deterministic** - same inputs = same addresses
- ✅ **No capacity limits** - unlimited "addresses"
- ✅ **Simpler architecture** - one less component to manage
- ✅ **No activation delays** - instant availability

### Cons

- ❌ **Transaction size** - All addresses must be in transaction (32 bytes each)
- ❌ **Potentially too large** - 19 addresses × 32 bytes = 608 bytes just for addresses
- ❌ **No compression** - Can't use 1-byte indexes instead of 32-byte addresses

### Transaction Size Impact

**Current (with lookup table):**
- ~15-20 addresses referenced by 1-byte indexes
- Total address overhead: ~15-20 bytes (indexes)

**Without lookup table:**
- 19 addresses × 32 bytes = 608 bytes
- Plus instruction data, signatures, etc.
- **Risk**: May exceed 1232 byte transaction limit

### Verdict: ⚠️ **Risky**

While derivation is elegant, it likely makes transactions too large. However, worth testing!

---

## Option 2: Hybrid Approach - Derive + Compress

### Concept

Derive addresses locally, but use a compact encoding scheme to compress them in transactions.

### Implementation Ideas

**A. Address Index Registry (On-Chain)**
```rust
// On-chain registry mapping indices to addresses
pub struct AddressRegistry {
  pub addresses: Vec<Pubkey>,  // Max 256 addresses
  pub version: u8,
}
```

- Store common addresses in a registry PDA
- Reference by index (1 byte instead of 32 bytes)
- Similar to lookup tables but program-controlled

**B. Compressed Address Encoding**
- Use mathematical/constant-based indexing
- Encode addresses as indexes based on derivation order
- Example: `poolState = index 0, nullifierSet = index 1, etc.`

**C. Transaction-Level Compression**
- Program accepts compressed address format
- Decompresses addresses in instruction handler
- Requires program changes

### Pros

- ✅ Smaller transactions than full derivation
- ✅ Can work within transaction limits
- ✅ More control than lookup tables

### Cons

- ❌ Requires program changes
- ❌ More complex implementation
- ❌ Still need on-chain storage for registry

### Verdict: 💡 **Interesting but Complex**

Worth exploring if transaction sizes become an issue, but adds complexity.

---

## Option 3: Index-Based Derivation Scheme

### Concept

Use a mathematical/constant-based indexing scheme where each address type has a fixed index.

### Example Implementation

```typescript
// Define index mapping based on derivation order
const ADDRESS_INDEX = {
  POOL_STATE: 0,
  NULLIFIER_SET: 1,
  COMMITMENT_TREE: 2,
  NOTE_LEDGER: 3,
  // ... etc
} as const;

// In transaction, use 1-byte index
// In program, derive address from index + originMint
```

### Pros

- ✅ **1-byte indexes** instead of 32-byte addresses
- ✅ **Fully deterministic** - same as PDA derivation
- ✅ **No lookup table storage** needed
- ✅ **No capacity limits** (if we encode properly)

### Cons

- ❌ **Requires program changes** - programs must accept index format
- ❌ **Fixed address order** - hard to change once deployed
- ❌ **Can't handle variable addresses** - still need full addresses for user wallets

### Verdict: 💡 **Novel but Requires Program Changes**

This is essentially what lookup tables do, but with program-level support. Solana lookup tables already provide this without program changes.

---

## Option 4: Smart Compression Algorithm

### Concept

Use advanced compression to encode addresses more efficiently than 32 bytes.

### Ideas

**A. Shared Prefix Compression**
- Most PDAs share same program ID
- Encode: `[program_id (32 bytes), seed_index (1-2 bytes)]`
- Can compress from 32 bytes to ~2-3 bytes per address

**B. Delta Encoding**
- Encode addresses as offsets from a base address
- Use mathematical relationships between PDAs

**C. Hash-Based Indexing**
- Hash address to 1-2 byte index
- Handle collisions with chaining
- Similar to lookup tables but client-side

### Pros

- ✅ Smaller transaction sizes
- ✅ Can work with existing programs (if we decompress client-side)
- ✅ More efficient than full addresses

### Cons

- ❌ Complex encoding/decoding
- ❌ Risk of collisions
- ❌ Programs still need full addresses (must decompress)

### Verdict: ⚠️ **Complex and Risky**

Interesting idea, but adds complexity and potential bugs. Lookup tables already solve this problem.

---

## Option 5: Program-Level Address Derivation

### Concept

Move address derivation into the program itself. Transaction only sends `originMint` + minimal data, program derives all addresses.

### Implementation

```rust
// In program instruction
pub fn shield(ctx: Context<Shield>, origin_mint: Pubkey, amount: u64) -> Result<()> {
  // Program derives all addresses internally
  let pool_state = derive_pool_state(&origin_mint)?;
  let commitment_tree = derive_commitment_tree(&origin_mint)?;
  // ... etc
  
  // Program validates accounts match derived addresses
  require_keys_eq!(ctx.accounts.pool_state.key(), pool_state);
  require_keys_eq!(ctx.accounts.commitment_tree.key(), commitment_tree);
}
```

### Pros

- ✅ **Smallest transaction size** - only send originMint + data
- ✅ **No lookup tables needed**
- ✅ **Fully deterministic**
- ✅ **Program validates** - ensures correct addresses

### Cons

- ❌ **Requires program changes** - major refactor
- ❌ **All programs must support** - pool, factory, vault
- ❌ **Can't handle variable addresses** - still need user wallet in accounts
- ❌ **Less flexible** - harder to extend with new accounts

### Verdict: 💡 **Best Long-Term but Major Effort**

This is the most elegant solution but requires rewriting how accounts are passed to programs.

---

## Comparison Matrix

| Option | Transaction Size | Storage | Network Calls | Program Changes | Complexity |
|--------|-----------------|---------|---------------|-----------------|------------|
| **Current (Lookup Tables)** | ✅ Small (indexes) | ⚠️ 5GB/1M tokens | ⚠️ 3 calls | ✅ None | ✅ Low |
| **Full PDA Derivation** | ❌ Large (608 bytes) | ✅ Zero | ✅ Zero | ✅ None | ✅ Low |
| **Hybrid (Registry)** | ✅ Small | ⚠️ Similar | ⚠️ 1-2 calls | ❌ Yes | ⚠️ Medium |
| **Index-Based** | ✅ Small | ✅ Zero | ✅ Zero | ❌ Yes | ⚠️ Medium |
| **Smart Compression** | ✅ Small | ✅ Zero | ✅ Zero | ⚠️ Maybe | ❌ High |
| **Program Derivation** | ✅✅ Smallest | ✅ Zero | ✅ Zero | ❌ Yes | ❌ High |

---

## Recommendation

### Short-Term: Keep Lookup Tables ✅

**Why:**
1. **Already working** - tested and deployed
2. **No program changes** - can be done entirely in SDK
3. **Optimal transaction size** - fits within limits
4. **Scalable** - handles millions of tokens
5. **Proven technology** - Solana-native solution

### Medium-Term: Optimize Current Approach

**Improvements:**
1. **Monitor address count** - alert if approaching 256 limit
2. **Optimize address list** - remove duplicates, reuse common addresses
3. **Multiple tables** - split if needed (use multiple tables in one transaction)

### Long-Term: Consider Program-Level Derivation

**If transaction sizes become critical:**
- Implement Option 5 (program-level derivation)
- Programs derive addresses from `originMint` internally
- Transactions become much smaller
- Requires major refactor but ultimate solution

---

## Testing Full PDA Derivation (Quick Win)

Since most addresses can be derived, let's test if we can eliminate lookup tables entirely:

### Test Plan

1. **Create test transaction** with all addresses fully specified (no lookup table)
2. **Measure transaction size** - does it fit in 1232 bytes?
3. **If yes** - we can eliminate lookup tables!
4. **If no** - we know we need compression (lookup tables or alternative)

### Expected Result

Based on current transaction structure:
- Instruction data: ~500 bytes
- Account addresses (19 × 32 bytes): 608 bytes
- Signatures: 64 bytes
- Metadata: ~50 bytes
- **Total: ~1222 bytes** (close to 1232 limit)

**Verdict**: Might work for simple transactions, but risky for complex ones.

---

## Conclusion

### ✅ **IMPLEMENTED: Option 5 - Program-Level Address Derivation**

**Status**: This approach has been fully implemented and is now the production architecture.

**Implementation Details:**
- Created centralized `AddressDeriver` module in `ptf_common`
- Updated all programs (`ptf_pool`, `ptf_factory`, `ptf_vault`) to derive addresses internally
- Removed all lookup table creation, extension, and storage logic
- Transactions now use standard `Transaction` format (no `VersionedTransaction`)
- All PDAs are derived deterministically from `originMint`

**Benefits Realized:**
1. ✅ **Maximum scalability** - No lookup table capacity limits
2. ✅ **Simplified architecture** - No lookup table management
3. ✅ **Zero storage overhead** - No lookup tables to create or maintain
4. ✅ **Small transaction size** - Only `originMint` + instruction data needed
5. ✅ **Program-enforced validation** - All addresses validated on-chain

**See**: [`program-level-address-derivation.md`](./program-level-address-derivation.md) for complete documentation.

---

## Historical Context

This document was created during the evaluation phase when lookup tables were still in use. The decision was made to implement Option 5 (Program-Level Address Derivation) as it provides the best long-term scalability and eliminates all lookup table complexity.

The other options (1-4) were considered but not implemented:
- **Option 1**: Full PDA derivation without lookup tables - Transaction size concerns
- **Option 2**: Hybrid approach with compression - Too complex
- **Option 3**: Index-based derivation - Requires program changes (similar to Option 5)
- **Option 4**: Smart compression algorithms - Too risky and complex

**Current Architecture**: All programs now use program-level derivation as described in Option 5.

