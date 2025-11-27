# Lookup Table Scalability Proposal (ARCHIVED)

> **⚠️ ARCHIVED**: This document describes a proposal that was superseded by program-level address derivation. The system no longer uses lookup tables. See [`program-level-address-derivation.md`](./program-level-address-derivation.md) for the current architecture.

## Historical Context

This document was created when the system used Address Lookup Tables (ALTs) to compress transaction sizes. The proposal outlined strategies for sharing lookup tables across users to improve scalability.

## Current Status

**The system no longer uses lookup tables.** All address derivation is now handled programmatically within the programs themselves. This eliminates:

- Lookup table creation and management
- Lookup table capacity limits (256 addresses)
- Storage overhead (~5GB per 1M tokens)
- Network calls for lookup table activation
- Extension race conditions

## Migration

The migration from lookup tables to program-level derivation was completed as part of the scalability improvements. All programs now derive PDAs internally from `originMint` and validate provided accounts match derived addresses.

## For Current Architecture

See [`program-level-address-derivation.md`](./program-level-address-derivation.md) for documentation on the current implementation.

---

## Original Proposal (Preserved for Historical Reference)

### Problem Statement

For millions of tokens, the current approach had critical scalability issues:

1. **O(n) Query Problem**: Querying all lookup tables owned by a wallet becomes O(n) where n could be millions
2. **Per-User Tables**: Each user creates their own lookup table per token (wasteful)
3. **No Sharing**: Lookup tables aren't shared across users
4. **Network Overhead**: Repeated queries for the same token

### Proposed Solution: Pool-Based Shared Lookup Tables

**One lookup table per pool, shared by all users.**

- Same pool = same lookup table (deterministic)
- First user to shield creates it
- All subsequent users reuse it
- O(1) lookup (just check if it exists)

### Architecture Options

#### Option 1: Store in MintMapping (Recommended - Requires Program Upgrade)

**Pros:**
- Single source of truth (on-chain)
- O(1) lookup (just read MintMapping)
- Fully decentralized
- No additional accounts needed

**Cons:**
- Requires extending MintMapping struct
- Needs program upgrade

#### Option 2: Registry PDA (Interim Solution - No Program Changes)

**Pros:**
- Works immediately (no program upgrade)
- Still O(1) lookup
- Decentralized

**Cons:**
- Additional account per pool
- Slightly more complex

#### Option 3: Factory State as Shared Authority (Current Workaround)

**Pros:**
- No program changes
- Works immediately
- Decentralized (factory state is protocol-owned)

**Cons:**
- Can't derive lookup table deterministically
- Still need to query/check existence
- Requires factory program to manage lookup tables

---

**Note**: None of these options were implemented. Instead, the system was migrated to program-level address derivation, which eliminates the need for lookup tables entirely.
