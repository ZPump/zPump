# Lookup Table Scalability Proposal

## Problem Statement

For millions of tokens, the current approach has critical scalability issues:

1. **O(n) Query Problem**: Querying all lookup tables owned by a wallet becomes O(n) where n could be millions
2. **Per-User Tables**: Each user creates their own lookup table per token (wasteful)
3. **No Sharing**: Lookup tables aren't shared across users
4. **Network Overhead**: Repeated queries for the same token

## Proposed Solution: Pool-Based Shared Lookup Tables

### Core Concept

**One lookup table per pool, shared by all users.**

- Same pool = same lookup table (deterministic)
- First user to shield creates it
- All subsequent users reuse it
- O(1) lookup (just check if it exists)

### Architecture

#### Option 1: Store in MintMapping (Recommended - Requires Program Upgrade)

**Pros:**
- Single source of truth (on-chain)
- O(1) lookup (just read MintMapping)
- Fully decentralized
- No additional accounts needed

**Cons:**
- Requires extending MintMapping struct
- Needs program upgrade

**Implementation:**
```rust
// In ptf_factory program
#[account]
pub struct MintMapping {
    pub origin_mint: Pubkey,
    pub ptkn_mint: Pubkey,
    pub pool: Pubkey,
    pub lookup_table: Option<Pubkey>, // NEW: Store lookup table address
    // ... existing fields
}
```

**Flow:**
1. User calls `wrap()` for token
2. SDK reads MintMapping
3. If `lookup_table` is `Some(address)`: Use it
4. If `lookup_table` is `None`: Create lookup table, store in MintMapping via factory instruction

#### Option 2: Registry PDA (Interim Solution - No Program Changes)

**Pros:**
- Works immediately (no program upgrade)
- Still O(1) lookup
- Decentralized

**Cons:**
- Additional account per pool
- Slightly more complex

**Implementation:**
```typescript
// Derive registry PDA for pool
function deriveLookupTableRegistry(poolState: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode('lookup-registry'), poolState.toBuffer()],
    FACTORY_PROGRAM_ID
  )[0];
}

// Registry stores: { lookupTable: PublicKey }
```

**Flow:**
1. User calls `wrap()` for token
2. SDK reads registry PDA
3. If exists: Use stored lookup table
4. If not: Create lookup table, initialize registry PDA

#### Option 3: Factory State as Shared Authority (Current Workaround)

**Pros:**
- No program changes
- Works immediately
- Decentralized (factory state is protocol-owned)

**Cons:**
- Can't derive lookup table deterministically
- Still need to query/check existence
- Requires factory program to manage lookup tables

**Implementation:**
- Use factory state as lookup table authority
- Create lookup table per pool with factory as authority
- Store address in off-chain cache (localStorage) + on-chain registry (future)

### Recommended Approach: Hybrid (Option 2 + Option 1 Migration Path)

**Phase 1 (Immediate - No Program Changes):**
1. Create registry PDA per pool
2. Store lookup table address in registry
3. First user creates lookup table + initializes registry
4. Subsequent users read registry (O(1))

**Phase 2 (Future - Program Upgrade):**
1. Extend MintMapping to include lookup_table field
2. Migrate registry data to MintMapping
3. Deprecate registry PDAs

### Scalability Characteristics

**With Registry/MintMapping Storage:**
- **Lookup Time**: O(1) - Single account read
- **Storage**: 1 account per pool (or field in existing MintMapping)
- **Network Calls**: 1 RPC call per shield (read registry/MintMapping)
- **Decentralization**: ✅ Fully decentralized (on-chain storage)
- **Sharing**: ✅ All users share same lookup table per pool

**Comparison:**

| Approach | Lookup Time | Storage | Network Calls | Decentralized |
|----------|-------------|---------|---------------|---------------|
| Current (query all) | O(n) | 0 | n queries | ✅ |
| Cache only | O(1) cached | 0 | 0 cached, n if miss | ❌ |
| Registry PDA | O(1) | 1 per pool | 1 | ✅ |
| MintMapping | O(1) | 0 (uses existing) | 1 | ✅ |

### Implementation Details

#### Registry PDA Structure

```typescript
interface LookupTableRegistry {
  pool: PublicKey;
  lookupTable: PublicKey;
  createdBy: PublicKey; // First user who created it
  createdAt: number; // Timestamp
}
```

#### Creation Flow

1. User attempts shield
2. SDK checks registry PDA for pool
3. If exists and valid: Use it
4. If not exists:
   - Create lookup table with factory state as authority
   - Initialize registry PDA with lookup table address
   - Use the newly created lookup table

#### Extension Flow

If lookup table exists but missing addresses:
- Extend existing lookup table (anyone can extend)
- No need to create new one

### Benefits

1. **Scalability**: O(1) lookup regardless of number of tokens
2. **Decentralization**: On-chain storage, no central authority
3. **Efficiency**: One lookup table per pool, shared by all users
4. **Cost**: Minimal (one account per pool, or field in existing account)
5. **User Experience**: Instant lookup after first creation

### Migration Strategy

1. **Immediate**: Implement registry PDA approach
2. **Short-term**: Add caching layer (localStorage) for performance
3. **Long-term**: Migrate to MintMapping when program upgrade is possible

### Code Changes Required

1. Add `deriveLookupTableRegistry()` to `pdas.ts`
2. Add registry read/init logic to `wrap()` function
3. Use factory state as lookup table authority
4. Store lookup table address in registry on creation

