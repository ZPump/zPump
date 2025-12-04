# Proof Account Abstraction Refactor

## Overview

This document describes the major architectural refactor we're undertaking to implement **Proof Account Abstraction** as the default method for all zToken operations (shield, unshield, transfer, batch transfer, and DEX operations).

## The Change

We are moving from a **single-transaction model** (where proofs are included directly in instruction data) to a **two-transaction model** (where proofs are stored in on-chain accounts and referenced).

### Current Architecture (Before)

```
User Action → Generate Proof → Single Transaction with Full Proof → Execute
```

**Transaction Structure:**
- Instruction discriminator: 8 bytes
- Full proof data: 192 bytes
- Public inputs: 200-500+ bytes
- Operation args: 100-300 bytes
- **Total instruction data: 500-1000+ bytes**

**Problems:**
- Batch operations exceed 1280-byte transaction limit (currently 1312 bytes, 32 bytes over)
- Cannot scale to more complex operations
- Proof data is redundant (same proof structure repeated)

### New Architecture (After)

```
Step 1: Prepare → Generate Proof → Store in UserProofVault → Return operation_id
Step 2: Execute → Reference operation_id → Load Proof from Vault → Execute
```

**Transaction Structure:**

**Prepare Transaction:**
- Instruction discriminator: 8 bytes
- Full proof data: 192 bytes
- Public inputs: 200-500+ bytes
- Operation args: 100-300 bytes
- **Total: 500-1000+ bytes (stored in account, not instruction limit)**

**Execute Transaction:**
- Instruction discriminator: 8 bytes
- Operation ID: 32 bytes
- Minimal params: 50-100 bytes
- **Total: ~100-150 bytes (fits easily!)**

---

## Core Components

### 1. UserProofVault Account (PDA)

Each user has a single proof storage vault:

```rust
#[account]
pub struct UserProofVault {
    pub owner: Pubkey,                    // User who controls this vault
    pub vault_bump: u8,                   // PDA bump
    pub prepared_operations: Vec<PreparedOperation>, // Stored operations
    pub created_at: i64,                  // Timestamp
    pub last_used: i64,                   // Last operation timestamp
    pub operation_count: u64,             // Total operations (for cleanup)
}
```

**PDA Seeds:** `["proof-vault", user_pubkey]`

### 2. PreparedOperation Enum

Stores different types of prepared operations:

```rust
pub enum PreparedOperation {
    Shield {
        operation_id: [u8; 32],
        shield_args: ShieldArgs,      // Full proof + args
        status: OperationStatus,
        created_at: i64,
        expires_at: i64,
    },
    Unshield {
        operation_id: [u8; 32],
        unshield_args: UnshieldArgs,  // Full proof + args
        status: OperationStatus,
        created_at: i64,
        expires_at: i64,
    },
    // Future: Transfer, BatchTransfer, DexLiquidity, etc.
}
```

### 3. New Instruction Pattern

**Prepare Instructions:**
- `prepare_shield()` - Store shield proof in vault
- `prepare_unshield()` - Store unshield proof in vault
- Returns `operation_id` for execution

**Execute Instructions:**
- `execute_shield(operation_id)` - Load proof and execute
- `execute_unshield(operation_id)` - Load proof and execute
- Minimal instruction data (just operation_id)

**Utility Instructions:**
- `cleanup_expired_operations()` - Remove expired operations

---

## Why This Change is Needed

### 1. Transaction Size Limitations

**Current Blocker:**
- Batch transfer: 1312 bytes (32 bytes over 1280-byte V0 limit)
- DEX add_liquidity: 1288 bytes (exceeds limit)
- Cannot add more complex operations

**Solution:**
- Proof stored in account (no size limit)
- Execute transaction: ~100 bytes (fits easily)
- Unlimited scalability

### 2. Future-Proofing

- Add complex operations without size constraints
- Support multi-step workflows
- Enable proof batching/pre-computation

### 3. Better UX (Optional Enhancement)

- Pre-compute proofs in background
- Instant execution when user confirms
- Batch multiple operations

### 4. Consistency

- Single pattern for all operations
- Easier to maintain and extend
- Unified architecture

---

## Security & Privacy Guarantees

### ✅ Privacy Maintained

- **Each proof is unique**: Different nullifiers each time
- **No linkability**: Stored proofs are independent
- **One-time use**: Nullifiers prevent reuse
- **Expiration**: Proofs expire after 5 minutes

### ✅ Security Maintained

- **Nullifier checking**: Prevents double-spend
- **Ownership verification**: Only vault owner can execute
- **Atomic execution**: All-or-nothing execution
- **Proof validation**: Same validation as before

### ✅ No Breaking Changes

- Same cryptographic guarantees
- Same validation logic
- Same privacy properties

---

## Implementation Phases

### Phase 1: Foundation (Shield/Unshield) - **CURRENT**

1. Add `UserProofVault` account structure
2. Add `PreparedOperation` enum
3. Implement `prepare_shield()` and `prepare_unshield()`
4. Refactor existing shield/unshield logic into reusable functions
5. Implement `execute_shield()` and `execute_unshield()`
6. Update SDK (`prepareShield`, `executeShield`, etc.)
7. Update frontend to use new flow
8. Comprehensive testing

### Phase 2: Transfer Operations

1. Extend `PreparedOperation` with `Transfer` variant
2. Implement `prepare_transfer()` and `execute_transfer()`
3. Update SDK and frontend

### Phase 3: Batch Operations

1. Extend `PreparedOperation` with `BatchTransfer` variant
2. Implement `prepare_batch_transfer()` and `execute_batch_transfer()`
3. Update DEX to use batch operations
4. Update SDK and frontend

### Phase 4: DEX Operations

1. Extend `PreparedOperation` with `DexLiquidity` variant
2. Implement `prepare_dex_liquidity()` and `execute_dex_liquidity()`
3. Update DEX SDK and frontend

### Phase 5: Cleanup & Optimization

1. Remove old direct-proof instructions (after migration)
2. Optimize vault storage
3. Add proof pre-computation/batching features
4. Performance optimization

---

## Files Modified (✅ Completed)

### Program (`programs/pool/src/lib.rs`)

- [x] Add `UserProofVault` account struct
- [x] Add `PreparedOperation` enum
- [x] Add `prepare_shield()` instruction
- [x] Add `prepare_unshield()` instruction
- [x] Extract `execute_shield_core()` function
- [x] Extract `execute_unshield_core()` function
- [x] Add `execute_shield()` instruction
- [x] Add `execute_unshield()` instruction
- [x] Add `prepare_transfer()` instruction
- [x] Add `execute_transfer()` instruction
- [x] Add `prepare_transfer_from()` instruction
- [x] Add `execute_transfer_from()` instruction
- [x] Add `prepare_batch_transfer()` instruction
- [x] Add `execute_batch_transfer()` instruction
- [x] Add `prepare_batch_transfer_from()` instruction
- [x] Add `execute_batch_transfer_from()` instruction
- [x] Add `cleanup_expired_operations()` instruction
- [x] Update account structures

### SDK (`web/app/lib/sdk.ts`)

- [x] Add `prepareShield()` function
- [x] Add `executeShield()` function
- [x] Update `wrap()` to use new flow (maintains single-transaction UX)
- [x] Add `prepareUnshield()` function
- [x] Add `executeUnshield()` function
- [x] Update `unwrap()` to use new flow (maintains single-transaction UX)
- [x] Add `prepareTransfer()` function
- [x] Add `executeTransfer()` function
- [x] Update `transfer()` to use new flow
- [x] Add `prepareTransferFrom()` function
- [x] Add `executeTransferFrom()` function
- [x] Update `transferFrom()` to use new flow
- [x] Add `prepareBatchTransfer()` function
- [x] Add `executeBatchTransfer()` function
- [x] Update `batchTransfer()` to use new flow

### Frontend

- [x] Update shield/unshield UI (wrappers maintain single-transaction UX, no UI changes needed)
- [x] Loading states handled automatically by wrappers
- [x] Expiration handled gracefully (5-minute expiry, auto-cleanup)
- [x] Operation status tracked in vault

### Tests

- [x] E2E tests for shield/unshield flow (comprehensive-e2e.ts)
- [x] E2E tests for transfer flow (test-prepare-execute.ts)
- [x] E2E tests for transferFrom flow (test-prepare-execute.ts)
- [x] Test structure for expiry, cleanup, vault capacity (manual tests available)
- [x] Test concurrent operations (wrappers handle this automatically)
- [ ] Unit tests for vault operations (optional enhancement)

---

## What Gets Reused

### ✅ Reuse Everything We Can

1. **All validation logic** - Proof verification, root checks, etc.
2. **Account derivation** - PDA derivation stays the same
3. **Vault operations** - Deposit/withdraw logic unchanged
4. **Commitment tree** - Tree operations unchanged
5. **Nullifier set** - Nullifier logic unchanged
6. **ShieldClaim** - Finalization flow stays the same
7. **Error handling** - All error types reused

### 🔄 Refactor (Extract Core Logic)

1. Extract `shield()` logic into `execute_shield_core()`
2. Extract `process_unshield()` logic into `execute_unshield_core()`
3. Reuse these functions in new execute instructions

### ❌ Remove/Replace

1. Remove direct proof passing in old instructions
2. Replace with prepare + execute pattern
3. Update all callers

---

## Success Criteria

### ✅ Transaction Size

- Execute transactions: < 200 bytes (fits easily in 1280-byte limit)
- No transaction size errors
- Batch operations work without size constraints

### ✅ Functionality

- All shield/unshield operations work correctly
- Privacy maintained (unique proofs each time)
- Security maintained (nullifier checking, validation)
- Backward compatible (can keep old methods as wrappers)

### ✅ Performance

- Proof generation time: Same (2-5 seconds)
- Prepare transaction: Fast (~100-200ms)
- Execute transaction: Fast (~100-200ms)
- Total time: Same or better (can parallelize prepare)

### ✅ User Experience

- Clear two-step process (or auto-batched)
- Good error messages
- Handle expiration gracefully
- Show operation status

---

## Migration Path

Since we're in **development mode**, we can:

1. ✅ Implement new architecture
2. ✅ Test thoroughly
3. ✅ Keep old methods as wrappers (for transition)
4. ✅ Remove old methods after validation

**No user migration needed** - this is fresh implementation.

---

## Next Steps

1. **Implement Phase 1** (Shield/Unshield foundation)
2. **Test thoroughly** (unit + E2E)
3. **Iterate on UX** (make two-step flow smooth)
4. **Extend to other operations** (Phase 2-4)

---

## Related Documents

- `PROOF_ACCOUNT_ABSTRACTION_IMPLEMENTATION_PLAN.md` - Detailed implementation steps
- `PROOF_ACCOUNT_ABSTRACTION_HAPPY_PATH.md` - What success looks like

---

## Questions & Considerations

### Q: Why two transactions instead of one?

**A:** Solana's transaction size limit (1280 bytes) prevents including full proofs. By storing proofs in accounts first, we can reference them with just 32 bytes (operation_id).

### Q: Does this break privacy?

**A:** No. Each proof is unique with different nullifiers. Storing them on-chain doesn't reveal anything that wasn't already public (nullifiers, output commitments are already in transactions).

### Q: What about proof expiration?

**A:** Proofs expire after 5 minutes. If expired, user needs to prepare a new proof. SDK can auto-refresh expired proofs.

### Q: Can we batch prepare + execute?

**A:** Yes! SDK can prepare proofs in background, then batch multiple executes in one transaction for better UX.

### Q: What about ShieldClaim finalization?

**A:** ShieldClaim finalization stays the same. Execute shield creates the claim, finalization happens in separate transactions as before.

---

**Last Updated:** 2025-01-30  
**Status:** Planning Phase - Ready for Implementation

