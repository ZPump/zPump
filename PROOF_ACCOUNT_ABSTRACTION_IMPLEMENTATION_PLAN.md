# Proof Account Abstraction - Implementation Plan

## Overview

This document provides a detailed, step-by-step implementation plan for the Proof Account Abstraction refactor, starting with Shield/Unshield operations.

---

## Implementation Strategy

### Approach: Extract & Reuse

1. **Extract** core logic from existing `shield()` and `process_unshield()`
2. **Reuse** all validation, vault operations, tree operations
3. **Refactor** to two-step pattern (prepare + execute)
4. **Test** thoroughly at each step

### Key Principle

**Don't rewrite - refactor!** We're restructuring, not rebuilding. All the hard work (proof validation, vault operations, tree management) stays the same.

---

## Phase 1: Foundation (Shield/Unshield)

### Step 1: Add Account Structures (2-3 hours)

**File:** `programs/pool/src/lib.rs`

**Tasks:**

1. **Add `UserProofVault` account struct**
   ```rust
   #[account]
   pub struct UserProofVault {
       pub owner: Pubkey,
       pub vault_bump: u8,
       pub prepared_operations: Vec<PreparedOperation>,
       pub created_at: i64,
       pub last_used: i64,
       pub operation_count: u64,
   }
   
   impl UserProofVault {
       pub const MAX_OPERATIONS: usize = 10;
       pub const OPERATION_EXPIRY_SECONDS: i64 = 300; // 5 minutes
       pub const SPACE: usize = /* calculate */;
   }
   ```

2. **Add `PreparedOperation` enum**
   ```rust
   #[derive(AnchorSerialize, AnchorDeserialize, Clone)]
   pub enum PreparedOperation {
       Shield {
           operation_id: [u8; 32],
           shield_args: ShieldArgs,
           status: OperationStatus,
           created_at: i64,
           expires_at: i64,
       },
       Unshield {
           operation_id: [u8; 32],
           unshield_args: UnshieldArgs,
           status: OperationStatus,
           created_at: i64,
           expires_at: i64,
       },
   }
   ```

3. **Add `OperationStatus` enum**
   ```rust
   #[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
   pub enum OperationStatus {
       Prepared,
       Executing,
       Completed,
       Expired,
       Failed,
   }
   ```

4. **Add PDA derivation helper**
   ```rust
   pub fn derive_proof_vault(user: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
       Pubkey::find_program_address(&[b"proof-vault", user.as_ref()], program_id)
   }
   ```

**Testing:**
- Compile program
- Verify space calculations
- Test PDA derivation

---

### Step 2: Extract Core Logic (3-4 hours)

**File:** `programs/pool/src/lib.rs`

**Tasks:**

1. **Extract `execute_shield_core()` function**
   - Copy all logic from current `shield()` function (lines ~1035-1700)
   - Remove account struct dependency (accept Context directly)
   - Keep all validation, proof verification, vault operations
   - Return same Result type

   ```rust
   fn execute_shield_core<'info>(
       ctx: &Context<'_, '_, '_, 'info, Shield<'info>>,
       args: &ShieldArgs,
   ) -> Result<()> {
       // All existing shield() logic here
       // Just extracted into separate function
   }
   ```

2. **Extract `execute_unshield_core()` function**
   - Copy all logic from current `process_unshield()` function
   - Accept mode parameter
   - Keep all validation, proof verification, vault operations

   ```rust
   fn execute_unshield_core<'info>(
       ctx: &Context<'_, '_, '_, 'info, Unshield<'info>>,
       args: &UnshieldArgs,
       mode: UnshieldMode,
   ) -> Result<()> {
       // All existing process_unshield() logic here
   }
   ```

3. **Update existing `shield()` to call core**
   - Keep old `shield()` instruction for compatibility (temporary)
   - Call `execute_shield_core()` internally
   - Mark as deprecated

**Testing:**
- Existing tests should still pass
- Verify no functionality changes
- Test shield/unshield still work

---

### Step 3: Implement Prepare Instructions (2-3 hours)

**File:** `programs/pool/src/lib.rs`

**Tasks:**

1. **Add `PrepareShield` account struct**
   ```rust
   #[derive(Accounts)]
   pub struct PrepareShield<'info> {
       #[account(
           init_if_needed,
           payer = payer,
           space = UserProofVault::SPACE,
           seeds = [b"proof-vault", payer.key().as_ref()],
           bump
       )]
       pub proof_vault: AccountLoader<'info, UserProofVault>,
       
       #[account(mut)]
       pub payer: Signer<'info>,
       pub system_program: Program<'info, System>,
   }
   ```

2. **Implement `prepare_shield()` instruction**
   ```rust
   pub fn prepare_shield(
       ctx: Context<PrepareShield>,
       shield_args: ShieldArgs,
   ) -> Result<[u8; 32]> {
       let vault = &mut ctx.accounts.proof_vault.load_mut()?;
       
       // Validate ownership
       require_keys_eq!(
           vault.owner,
           ctx.accounts.payer.key(),
           PoolError::Unauthorized
       );
       
       // Generate operation_id
       let mut operation_id = [0u8; 32];
       // ... generate unique ID (hash of args + timestamp)
       
       // Check vault capacity
       require!(
           vault.prepared_operations.len() < UserProofVault::MAX_OPERATIONS,
           PoolError::VaultFull
       );
       
       // Set expiration
       let clock = Clock::get()?;
       let expires_at = clock.unix_timestamp + UserProofVault::OPERATION_EXPIRY_SECONDS;
       
       // Store operation
       let operation = PreparedOperation::Shield {
           operation_id,
           shield_args,
           status: OperationStatus::Prepared,
           created_at: clock.unix_timestamp,
           expires_at,
       };
       
       vault.prepared_operations.push(operation);
       vault.last_used = clock.unix_timestamp;
       vault.operation_count = vault.operation_count.checked_add(1)
           .ok_or(PoolError::AmountOverflow)?;
       
       Ok(operation_id)
   }
   ```

3. **Implement `prepare_unshield()` instruction**
   - Similar pattern to `prepare_shield()`
   - Store `UnshieldArgs` instead

**Testing:**
- Unit test prepare instructions
- Test vault creation
- Test operation storage
- Test expiration setting

---

### Step 4: Implement Execute Instructions (3-4 hours)

**File:** `programs/pool/src/lib.rs`

**Tasks:**

1. **Add `ExecuteShield` account struct**
   ```rust
   #[derive(Accounts)]
   pub struct ExecuteShield<'info> {
       #[account(
           mut,
           seeds = [b"proof-vault", payer.key().as_ref()],
           bump = proof_vault.load()?.vault_bump,
           constraint = proof_vault.load()?.owner == payer.key() @ PoolError::Unauthorized
       )]
       pub proof_vault: AccountLoader<'info, UserProofVault>,
       
       // All existing Shield accounts (reuse Shield struct fields)
       // pool_state, vault_state, commitment_tree, etc.
       // ... (copy from existing Shield struct)
   }
   ```

2. **Implement `execute_shield()` instruction**
   ```rust
   pub fn execute_shield(
       ctx: Context<ExecuteShield>,
       operation_id: [u8; 32],
   ) -> Result<()> {
       let vault = &mut ctx.accounts.proof_vault.load_mut()?;
       let clock = Clock::get()?;
       
       // Find operation
       let operation = vault.prepared_operations
           .iter_mut()
           .find(|op| {
               if let PreparedOperation::Shield { operation_id: id, .. } = op {
                   *id == operation_id
               } else {
                   false
               }
           })
           .ok_or(PoolError::OperationNotFound)?;
       
       // Extract and validate
       let (shield_args, status) = match operation {
           PreparedOperation::Shield { shield_args, status, expires_at, .. } => {
               // Check expiration
               require!(clock.unix_timestamp < *expires_at, PoolError::OperationExpired);
               require!(*status == OperationStatus::Prepared, PoolError::InvalidOperationStatus);
               
               // Mark as executing
               *status = OperationStatus::Executing;
               
               (shield_args.clone(), status)
           },
           _ => return err!(PoolError::OperationNotFound),
       };
       
       // Execute core logic (reuse existing function)
       match execute_shield_core(&ctx, &shield_args) {
           Ok(()) => {
               // Mark as completed
               *status = OperationStatus::Completed;
               vault.last_used = clock.unix_timestamp;
               Ok(())
           },
           Err(e) => {
               // Mark as failed
               *status = OperationStatus::Failed;
               Err(e)
           }
       }
   }
   ```

3. **Implement `execute_unshield()` instruction**
   - Similar pattern to `execute_shield()`
   - Call `execute_unshield_core()` with mode

**Testing:**
- Test operation lookup
- Test expiration checking
- Test status transitions
- Test execution with stored proof
- Test error handling

---

### Step 5: Add Cleanup Utility (1 hour)

**File:** `programs/pool/src/lib.rs`

**Tasks:**

1. **Add `CleanupExpiredOperations` account struct**

2. **Implement `cleanup_expired_operations()` instruction**
   ```rust
   pub fn cleanup_expired_operations(
       ctx: Context<CleanupExpiredOperations>,
   ) -> Result<u64> {
       let vault = &mut ctx.accounts.proof_vault.load_mut()?;
       let clock = Clock::get()?;
       
       let initial_len = vault.prepared_operations.len();
       
       // Remove expired operations
       vault.prepared_operations.retain(|op| {
           let expires_at = match op {
               PreparedOperation::Shield { expires_at, .. } => *expires_at,
               PreparedOperation::Unshield { expires_at, .. } => *expires_at,
           };
           clock.unix_timestamp < expires_at
       });
       
       let removed = initial_len - vault.prepared_operations.len();
       Ok(removed as u64)
   }
   ```

**Testing:**
- Test cleanup removes expired operations
- Test cleanup keeps valid operations
- Test cleanup on empty vault

---

### Step 6: Update SDK - Shield (2-3 hours)

**File:** `web/app/lib/sdk.ts`

**Tasks:**

1. **Add `prepareShield()` function**
   ```typescript
   export async function prepareShield(params: {
     wallet: WalletContextState;
     connection: Connection;
     originMint: PublicKey | string;
     amount: bigint;
     recipient?: PublicKey | string;
     depositId?: string;
     blinding?: string;
     proof?: string;
     keypair?: Keypair;
   }): Promise<{ operationId: string; signature: string }> {
     // 1. Generate proof if not provided
     // 2. Build ShieldArgs
     // 3. Call prepare_shield instruction
     // 4. Return operation_id + signature
   }
   ```

2. **Add `executeShield()` function**
   ```typescript
   export async function executeShield(params: {
     wallet: WalletContextState;
     connection: Connection;
     operationId: string;
     keypair?: Keypair;
   }): Promise<string> {
     // 1. Build execute_shield instruction (just operation_id)
     // 2. Send transaction
     // 3. Return signature
   }
   ```

3. **Update `wrap()` function**
   ```typescript
   export async function wrap(params: WrapParams): Promise<string> {
     // Option A: Keep as convenience wrapper
     const { operationId } = await prepareShield(params);
     return await executeShield({
       wallet: params.wallet,
       connection: params.connection,
       operationId,
       keypair: params.keypair,
     });
     
     // Option B: Keep old implementation for now (transition period)
   }
   ```

**Testing:**
- Test prepare + execute flow
- Test proof generation
- Test operation_id handling
- Test error cases

---

### Step 7: Update SDK - Unshield (2-3 hours)

**File:** `web/app/lib/sdk.ts`

**Tasks:**

1. **Add `prepareUnshield()` function**
   - Similar to `prepareShield()`
   - Handle unshield-specific params

2. **Add `executeUnshield()` function**
   - Similar to `executeShield()`
   - Handle unshield-specific accounts

3. **Update `unwrap()` function**
   - Use new two-step flow
   - Or keep as convenience wrapper

**Testing:**
- Test prepare + execute flow
- Test unshield-specific logic
- Test SOL unwrapping flow

---

### Step 8: Update IDL (1 hour)

**File:** `web/app/idl/ptf_pool.json`

**Tasks:**

1. **Build new IDL** with Anchor
   ```bash
   anchor build
   ```

2. **Update IDL file** in web app

3. **Verify** all new instructions are present

**Testing:**
- SDK can call new instructions
- Type generation works
- No breaking changes to existing instructions

---

### Step 9: Testing - Unit Tests (4-6 hours)

**Files:** `tests/` or `programs/pool/src/`

**Tasks:**

1. **Test UserProofVault operations**
   - Vault creation
   - Operation storage
   - Operation lookup
   - Status transitions

2. **Test prepare instructions**
   - Prepare shield
   - Prepare unshield
   - Expiration setting
   - Vault capacity

3. **Test execute instructions**
   - Execute with valid operation
   - Execute with expired operation
   - Execute with wrong owner
   - Error handling

4. **Test cleanup**
   - Remove expired operations
   - Keep valid operations

---

### Step 10: Testing - E2E Tests (4-6 hours)

**File:** `web/app/scripts/`

**Tasks:**

1. **Create E2E test for shield flow**
   ```typescript
   // Test prepare + execute shield
   // Test expiration handling
   // Test concurrent operations
   ```

2. **Create E2E test for unshield flow**
   ```typescript
   // Test prepare + execute unshield
   // Test SOL unwrapping
   // Test error cases
   ```

3. **Update existing tests**
   - Update shield/unshield tests to use new flow
   - Verify all existing tests pass

---

## Implementation Checklist

### Program (Rust)

- [ ] Add `UserProofVault` account struct
- [ ] Add `PreparedOperation` enum
- [ ] Add `OperationStatus` enum
- [ ] Add PDA derivation helper
- [ ] Extract `execute_shield_core()` function
- [ ] Extract `execute_unshield_core()` function
- [ ] Add `PrepareShield` account struct
- [ ] Implement `prepare_shield()` instruction
- [ ] Add `PrepareUnshield` account struct
- [ ] Implement `prepare_unshield()` instruction
- [ ] Add `ExecuteShield` account struct
- [ ] Implement `execute_shield()` instruction
- [ ] Add `ExecuteUnshield` account struct
- [ ] Implement `execute_unshield()` instruction
- [ ] Add `CleanupExpiredOperations` account struct
- [ ] Implement `cleanup_expired_operations()` instruction
- [ ] Update error types if needed
- [ ] Build and verify program compiles

### SDK (TypeScript)

- [ ] Add `prepareShield()` function
- [ ] Add `executeShield()` function
- [ ] Update `wrap()` function (or keep as wrapper)
- [ ] Add `prepareUnshield()` function
- [ ] Add `executeUnshield()` function
- [ ] Update `unwrap()` function (or keep as wrapper)
- [ ] Update IDL file
- [ ] Verify SDK compiles

### Tests

- [ ] Unit tests for vault operations
- [ ] Unit tests for prepare instructions
- [ ] Unit tests for execute instructions
- [ ] E2E test for shield flow
- [ ] E2E test for unshield flow
- [ ] Update existing tests
- [ ] Test expiration handling
- [ ] Test cleanup function

---

## Estimated Timeline

- **Step 1-2:** Foundation (Account structures + Extract core) - 1 day
- **Step 3-4:** Prepare + Execute instructions - 1 day
- **Step 5:** Cleanup utility - 2 hours
- **Step 6-7:** SDK updates - 1 day
- **Step 8:** IDL update - 1 hour
- **Step 9-10:** Testing - 2 days

**Total:** ~5-6 days of focused development

---

## Success Criteria

### Functionality

- [ ] Shield operations work with new flow
- [ ] Unshield operations work with new flow
- [ ] Expiration handling works correctly
- [ ] Cleanup removes expired operations
- [ ] All existing functionality preserved

### Transaction Size

- [ ] Prepare transaction: Any size (stored in account)
- [ ] Execute transaction: < 200 bytes ✅
- [ ] No transaction size errors

### Security & Privacy

- [ ] Privacy maintained (unique proofs)
- [ ] Security maintained (nullifier checking)
- [ ] Ownership verification works
- [ ] Expiration prevents stale proof reuse

---

## Next Steps After Phase 1

1. **Validate approach** with shield/unshield
2. **Extend to transfer operations** (Phase 2)
3. **Extend to batch operations** (Phase 3)
4. **Extend to DEX operations** (Phase 4)
5. **Remove old instructions** (Phase 5)

---

**Last Updated:** 2025-01-30  
**Status:** Ready to Implement - Phase 1

