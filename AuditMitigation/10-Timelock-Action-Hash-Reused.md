# Fix 10: Timelock Action Hash Can Be Reused (HIGH)

## Problem Description

### Location
- **Contract**: `ptf_factory`
- **File**: `programs/factory/src/lib.rs`
- **Lines**: 188-240

### Current Behavior
The `queue_timelock_action` function uses a salt to create unique action hashes, but the same action can be queued multiple times with different salts. This creates confusion about which action to execute and could be used for spam attacks.

### Code Snippet (Current - Problematic)

```rust
pub fn queue_timelock_action(
    ctx: Context<QueueTimelockAction>,
    salt: [u8; 32],
    action: TimelockAction,
) -> Result<()> {
    // ... validation ...
    
    let action_bytes = action
        .try_to_vec()
        .map_err(|_| error!(FactoryError::SerializationError))?;
    let expected_hash = hashv(&[
        state.key().as_ref(),
        &action_bytes,
        &execute_after.to_le_bytes(),
    ]);
    
    // ⚠️ PROBLEM: Same action can be queued multiple times with different salts
    // No deduplication or prevention of duplicate actions
    
    let entry = &mut ctx.accounts.timelock_entry;
    entry.factory = state.key();
    entry.salt = salt;  // Different salt = different entry, even for same action
    entry.action_hash = expected_hash.to_bytes();
    // ...
}
```

### Why This Is High Severity

1. **Confusion About Which Action to Execute**: If the same action is queued multiple times with different salts, it's unclear which one should be executed. This could lead to:
   - Executing the wrong action
   - Missing the intended action
   - Operational confusion

2. **Spam Attack Vector**: An attacker could spam the system with many duplicate actions:
   - Clogging the timelock system
   - Making it hard to find legitimate actions
   - Wasting storage and compute resources

3. **No Deduplication**: There's no mechanism to prevent or detect duplicate actions, making the system vulnerable to abuse.

4. **Operational Risk**: In practice, having multiple pending actions for the same change creates operational risk:
   - Which one is the "real" one?
   - What if they conflict?
   - How to manage them?

### Attack Scenario

1. Attacker (or compromised authority) queues the same action multiple times:
   - Action: `SetDefaultFeatures { features: 0xFF }`
   - Salt 1: `[0x01, ...]`
   - Salt 2: `[0x02, ...]`
   - Salt 3: `[0x03, ...]`
   - ... (many more)
2. System now has many pending actions for the same change
3. When timelock expires:
   - Which one to execute?
   - Could execute wrong one
   - Or execute multiple (if not prevented)
4. Creates confusion and potential for errors

## Solution

### Fix Strategy
Implement deduplication and prevention mechanisms:
1. **Action Deduplication**: Prevent queuing the same action multiple times
2. **Nonce/Sequence**: Add sequence numbers to prevent duplicates
3. **Time Window**: Prevent duplicate actions within a time window
4. **Maximum Pending**: Limit number of pending actions

### Implementation

#### Step 1: Add Action Hash Tracking

**Location**: `programs/factory/src/lib.rs` - Add to FactoryState

**Add**:
```rust
#[account]
pub struct FactoryState {
    // ... existing fields ...
    pub pending_action_hashes: Vec<[u8; 32]>,  // Track pending action hashes
    pub last_action_sequence: u64,  // Sequence number for actions
}

impl FactoryState {
    pub const SPACE: usize = 8 + 32 + 2 + 1 + 1 + 8 + 1 + 8 + 4 + (32 * 50) + 8;  // Adjust for new fields
    pub const MAX_PENDING_ACTIONS: usize = 50;
}
```

#### Step 2: Update `queue_timelock_action` to Check for Duplicates

**Location**: `programs/factory/src/lib.rs` around line 188

**Change**:
```rust
pub fn queue_timelock_action(
    ctx: Context<QueueTimelockAction>,
    salt: [u8; 32],
    action: TimelockAction,
) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    require!(!state.paused, FactoryError::Paused);

    let clock = Clock::get()?;
    let execute_after = clock
        .unix_timestamp
        .checked_add(state.timelock_seconds)
        .ok_or_else(|| error!(FactoryError::TimelockOverflow))?;

    let action_bytes = action
        .try_to_vec()
        .map_err(|_| error!(FactoryError::SerializationError))?;
    
    // CRITICAL FIX: Compute action hash (without salt for deduplication)
    let action_hash = hashv(&[
        state.key().as_ref(),
        &action_bytes,
        &execute_after.to_le_bytes(),
    ]);
    
    // CRITICAL FIX: Check for duplicate actions
    require!(
        !state.pending_action_hashes.contains(&action_hash.to_bytes()),
        FactoryError::DuplicateAction
    );
    
    // CRITICAL FIX: Check maximum pending actions
    require!(
        state.pending_action_hashes.len() < FactoryState::MAX_PENDING_ACTIONS,
        FactoryError::TooManyPendingActions
    );

    if let TimelockAction::UpdateMint { origin_mint, .. } = &action {
        let mapping = ctx
            .accounts
            .mint_mapping
            .as_ref()
            .ok_or(FactoryError::TimelockMissingMapping)?;
        require_keys_eq!(
            mapping.origin_mint,
            *origin_mint,
            FactoryError::OriginMintMismatch
        );
    }

    // Use salt + sequence for unique entry address
    let sequence = state.last_action_sequence.checked_add(1)
        .ok_or(FactoryError::SequenceOverflow)?;
    state.last_action_sequence = sequence;
    
    // Include sequence in entry seeds for uniqueness
    let entry = &mut ctx.accounts.timelock_entry;
    entry.factory = state.key();
    entry.salt = salt;
    entry.action_hash = action_hash.to_bytes();
    entry.queued_at = clock.unix_timestamp;
    entry.execute_after = execute_after;
    entry.executed = false;
    entry.action = action;
    entry.bump = ctx.bumps.timelock_entry;
    entry.sequence = sequence;  // Add sequence to entry
    
    // CRITICAL FIX: Track this action hash
    state.pending_action_hashes.push(action_hash.to_bytes());

    emit!(TimelockQueued {
        factory: state.key(),
        action_hash: entry.action_hash,
        sequence,
        queued_at: clock.unix_timestamp,
        execute_after,
    });
    Ok(())
}
```

#### Step 3: Update `execute_timelock_action` to Remove from Pending

**Location**: `programs/factory/src/lib.rs` around line 243

**Change**:
```rust
pub fn execute_timelock_action(ctx: Context<ExecuteTimelockAction>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    let entry = &mut ctx.accounts.timelock_entry;
    require!(!entry.executed, FactoryError::TimelockConsumed);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= entry.execute_after,
        FactoryError::TimelockNotReady
    );

    // Verify hash (from Fix 06)
    let action_bytes = entry.action
        .try_to_vec()
        .map_err(|_| error!(FactoryError::SerializationError))?;
    let expected_hash = hashv(&[
        state.key().as_ref(),
        &action_bytes,
        &entry.execute_after.to_le_bytes(),
    ]);
    require!(
        expected_hash == entry.action_hash,
        FactoryError::TimelockHashMismatch
    );

    // Execute action
    match &entry.action {
        // ... existing match arms ...
    }

    state.last_updated_slot = clock.slot;
    entry.executed = true;
    
    // CRITICAL FIX: Remove from pending hashes
    state.pending_action_hashes.retain(|&h| h != entry.action_hash);

    emit!(TimelockExecuted {
        factory: state.key(),
        action_hash: entry.action_hash,
        executed_at: clock.unix_timestamp,
        executor: ctx.accounts.executor.key(),
    });
    Ok(())
}
```

#### Step 4: Update `cancel_timelock_action` to Remove from Pending

**Location**: `programs/factory/src/lib.rs` around line 324

**Change**:
```rust
pub fn cancel_timelock_action(ctx: Context<CancelTimelockAction>) -> Result<()> {
    let entry = &mut ctx.accounts.timelock_entry;
    require!(!entry.executed, FactoryError::TimelockConsumed);
    
    let state = &mut ctx.accounts.factory_state;
    
    entry.executed = true;  // Mark as consumed
    entry.canceled = true;
    
    // CRITICAL FIX: Remove from pending hashes
    state.pending_action_hashes.retain(|&h| h != entry.action_hash);
    
    let clock = Clock::get()?;

    emit!(TimelockCanceled {
        factory: state.key(),
        action_hash: entry.action_hash,
        canceled_at: clock.unix_timestamp,
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}
```

#### Step 5: Update TimelockEntry to Include Sequence

**Location**: `programs/factory/src/lib.rs` - Update account struct

**Add**:
```rust
#[account]
pub struct TimelockEntry {
    pub factory: Pubkey,
    pub salt: [u8; 32],
    pub action_hash: [u8; 32],
    pub queued_at: i64,
    pub execute_after: i64,
    pub executed: bool,
    pub canceled: bool,  // NEW
    pub action: TimelockAction,
    pub bump: u8,
    pub sequence: u64,  // NEW
}

impl TimelockEntry {
    pub const MAX_ACTION_SIZE: usize = 128;
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 1 + Self::MAX_ACTION_SIZE + 1 + 8;
}
```

#### Step 6: Update QueueTimelockAction Account Seeds

**Location**: `programs/factory/src/lib.rs` - Update account struct

**Change**:
```rust
#[derive(Accounts)]
#[instruction(salt: [u8; 32], action: TimelockAction)]
pub struct QueueTimelockAction<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [
            seeds::TIMELOCK,
            factory_state.key().as_ref(),
            &factory_state.last_action_sequence.to_le_bytes(),  // Use sequence instead of salt
        ],
        bump,
        space = TimelockEntry::SPACE,
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub mint_mapping: Option<Account<'info, MintMapping>>,
}
```

#### Step 7: Add Error Types

**Location**: `programs/factory/src/lib.rs` in error enum

**Add**:
```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("E_DUPLICATE_ACTION")]
    DuplicateAction,
    #[msg("E_TOO_MANY_PENDING_ACTIONS")]
    TooManyPendingActions,
    #[msg("E_SEQUENCE_OVERFLOW")]
    SequenceOverflow,
    // ... other errors ...
}
```

### Testing

#### Test Case 1: Duplicate Action Rejected
```rust
#[test]
fn test_duplicate_action_rejected() {
    // Queue action
    // Try to queue same action again
    // Expected: Should fail with DuplicateAction
}
```

#### Test Case 2: Maximum Pending Actions
```rust
#[test]
fn test_max_pending_actions() {
    // Queue MAX_PENDING_ACTIONS actions
    // Try to queue one more
    // Expected: Should fail with TooManyPendingActions
}
```

#### Test Case 3: Action Removed After Execution
```rust
#[test]
fn test_action_removed_after_execution() {
    // Queue action
    // Execute action
    // Try to queue same action again
    // Expected: Should succeed (no longer pending)
}
```

### Verification Checklist

- [ ] FactoryState updated with pending_action_hashes
- [ ] Duplicate check added to queue_timelock_action
- [ ] Maximum pending check added
- [ ] Sequence number added
- [ ] Action removed from pending after execution
- [ ] Action removed from pending after cancel
- [ ] Error types added
- [ ] All tests pass
- [ ] Code review completed

### Additional Considerations

1. **Storage Cost**: Tracking pending hashes uses storage. Consider cleanup of old entries.

2. **Sequence Overflow**: Handle sequence overflow gracefully (unlikely but possible).

3. **Migration**: If factory already exists, initialize pending_action_hashes and last_action_sequence.

4. **Monitoring**: Monitor pending_action_hashes length to detect spam attempts.

### Impact Assessment

**Before Fix**: 
- Security: HIGH vulnerability
- Risk: Spam attacks, confusion about actions

**After Fix**:
- Security: Duplicates prevented
- Risk: Low (with proper limits)
- Breaking Change: Yes - requires state migration

### Rollout Plan

1. Update FactoryState structure
2. Add duplicate checking logic
3. Migrate existing factories (initialize new fields)
4. Deploy to testnet
5. Test duplicate prevention
6. Deploy to mainnet
7. Monitor for spam attempts

---

**Priority**: HIGH - Fix before production
**Estimated Effort**: Medium (add deduplication logic)
**Risk of Fix**: Low (makes code more secure)

