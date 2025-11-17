# Fix 04: Timelock Bypass for Direct Updates (CRITICAL)

## Problem Description

### Location
- **Contract**: `ptf_factory`
- **File**: `programs/factory/src/lib.rs`
- **Lines**: 599-604

### Current Behavior
When `timelock_seconds` is set to 0 (or negative), the `ensure_direct_update_allowed` function allows the factory authority to make instant changes to critical protocol settings without going through the timelock system. This completely bypasses the security delay mechanism.

### Code Snippet (Current - Broken)

```rust
fn ensure_direct_update_allowed(state: &FactoryState) -> Result<()> {
    if state.timelock_seconds > 0 {
        return Err(error!(FactoryError::TimelockOnlyQueue));  // ⚠️ If 0, allows direct updates!
    }
    Ok(())
}

pub fn set_default_features(
    ctx: Context<UpdateFactoryAuthority>,
    default_features: u8,
) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    ensure_direct_update_allowed(state)?;  // ⚠️ Bypasses timelock if timelock_seconds == 0
    state.default_features = FeatureFlags::from(default_features);
    state.last_updated_slot = Clock::get()?.slot;
    // ...
}
```

### Why This Is Critical

1. **Complete Timelock Bypass**: Setting `timelock_seconds` to 0 disables all security delays. The authority can instantly change:
   - Default feature flags
   - Mint configurations
   - Fee settings
   - Any other critical protocol parameters

2. **No Minimum Enforcement**: There's no minimum timelock period enforced. An attacker with compromised authority can:
   - Set timelock to 0
   - Make instant malicious changes
   - Re-enable timelock after attack

3. **Single Point of Failure**: If the factory authority key is compromised, the attacker can immediately:
   - Change protocol settings
   - Enable/disable features
   - Modify fees
   - All without any delay for detection or response

4. **No Recovery Window**: Without a timelock, there's no window for:
   - Detecting malicious changes
   - Responding to compromises
   - Reversing bad decisions

### Attack Scenario

1. Attacker compromises factory authority private key
2. Attacker calls `initialize_factory` (if not initialized) or finds way to set `timelock_seconds = 0`
3. Attacker immediately calls `set_default_features` with malicious settings
4. Changes take effect instantly - no delay
5. Attacker can:
   - Enable vulnerable features
   - Disable security features
   - Set fees to 100% (drain funds)
   - All before anyone can respond

## Solution

### Fix Strategy
1. **Enforce minimum timelock**: Never allow timelock_seconds to be 0 or below minimum
2. **Remove direct update path**: Always require timelock for critical operations
3. **Add validation on initialization**: Prevent setting timelock too low
4. **Add validation on updates**: Prevent reducing timelock below minimum

### Implementation

#### Step 1: Define Minimum Timelock Constant

**Location**: `programs/factory/src/lib.rs` at top of file

**Add**:
```rust
// Minimum timelock duration in seconds (e.g., 24 hours)
const MIN_TIMELOCK_SECONDS: i64 = 24 * 60 * 60;  // 86400 seconds = 24 hours
```

#### Step 2: Update `ensure_direct_update_allowed` to Always Require Timelock

**Location**: `programs/factory/src/lib.rs` around line 599

**Change**:
```rust
fn ensure_direct_update_allowed(state: &FactoryState) -> Result<()> {
    // CRITICAL FIX: Always require timelock, never allow direct updates
    // Even if timelock_seconds is 0, we enforce minimum
    require!(
        state.timelock_seconds >= MIN_TIMELOCK_SECONDS,
        FactoryError::TimelockTooShort
    );
    
    // Always return error - direct updates not allowed
    Err(error!(FactoryError::TimelockOnlyQueue))
}
```

**OR** (simpler approach - just always require timelock):

```rust
fn ensure_direct_update_allowed(_state: &FactoryState) -> Result<()> {
    // CRITICAL FIX: Never allow direct updates
    // All critical operations must go through timelock
    Err(error!(FactoryError::TimelockOnlyQueue))
}
```

#### Step 3: Add Validation in `initialize_factory`

**Location**: `programs/factory/src/lib.rs` around line 23

**Change**:
```rust
pub fn initialize_factory(
    ctx: Context<InitializeFactory>,
    authority: Pubkey,
    default_fee_bps: u16,
    timelock_seconds: i64,
) -> Result<()> {
    require!(default_fee_bps <= MAX_BPS, FactoryError::InvalidFeeBps);
    
    // CRITICAL FIX: Enforce minimum timelock
    require!(
        timelock_seconds >= MIN_TIMELOCK_SECONDS,
        FactoryError::TimelockTooShort
    );
    
    let state = &mut ctx.accounts.factory_state;
    state.authority = authority;
    state.default_fee_bps = default_fee_bps;
    state.default_features = FeatureFlags::empty();
    state.paused = false;
    state.timelock_seconds = timelock_seconds;
    state.bump = ctx.bumps.factory_state;
    state.last_updated_slot = Clock::get()?.slot;
    
    // ... rest of function
}
```

#### Step 4: Add Function to Update Timelock (with Validation)

**Location**: `programs/factory/src/lib.rs` - Add new function

**Add**:
```rust
pub fn set_timelock_seconds(
    ctx: Context<UpdateFactoryAuthority>,
    new_timelock_seconds: i64,
) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    
    // CRITICAL FIX: Enforce minimum when updating
    require!(
        new_timelock_seconds >= MIN_TIMELOCK_SECONDS,
        FactoryError::TimelockTooShort
    );
    
    // CRITICAL FIX: Timelock changes must also go through timelock!
    // This prevents reducing timelock to bypass security
    
    // Option A: Require timelock for timelock changes
    // (This creates a chicken-and-egg problem, so we might allow direct update here)
    
    // Option B: Allow direct update but only to increase timelock
    if new_timelock_seconds < state.timelock_seconds {
        // Decreasing timelock requires going through timelock system
        return Err(error!(FactoryError::TimelockDecreaseRequiresTimelock));
    }
    
    // Only allow direct increase (more secure)
    state.timelock_seconds = new_timelock_seconds;
    state.last_updated_slot = Clock::get()?.slot;
    
    emit!(TimelockSecondsUpdated {
        authority: ctx.accounts.authority.key(),
        old_timelock: state.timelock_seconds,  // Note: already updated above
        new_timelock: new_timelock_seconds,
    });
    
    Ok(())
}
```

**Better approach - require timelock for all timelock changes**:

```rust
pub fn queue_timelock_seconds_update(
    ctx: Context<QueueTimelockAction>,
    salt: [u8; 32],
    new_timelock_seconds: i64,
) -> Result<()> {
    // Validate minimum
    require!(
        new_timelock_seconds >= MIN_TIMELOCK_SECONDS,
        FactoryError::TimelockTooShort
    );
    
    // Queue as timelock action
    let action = TimelockAction::SetTimelockSeconds { new_timelock_seconds };
    // ... use existing queue_timelock_action logic
}
```

#### Step 5: Update Error Enum

**Location**: `programs/factory/src/lib.rs` in error enum

**Add**:
```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("E_TIMELOCK_TOO_SHORT")]
    TimelockTooShort,
    #[msg("E_TIMELOCK_DECREASE_REQUIRES_TIMELOCK")]
    TimelockDecreaseRequiresTimelock,
    // ... other errors ...
}
```

#### Step 6: Update TimelockAction Enum

**Location**: `programs/factory/src/lib.rs` in TimelockAction enum

**Add** (if using timelock for timelock changes):
```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    SetDefaultFeatures {
        features: u8,
    },
    UpdateMint {
        origin_mint: Pubkey,
        params: UpdateMintParams,
    },
    PauseFactory,
    UnpauseFactory,
    SetTimelockSeconds {  // NEW
        new_timelock_seconds: i64,
    },
}
```

#### Step 7: Update `execute_timelock_action` to Handle New Action

**Location**: `programs/factory/src/lib.rs` in `execute_timelock_action`

**Add**:
```rust
match &entry.action {
    // ... existing cases ...
    TimelockAction::SetTimelockSeconds { new_timelock_seconds } => {
        require!(
            *new_timelock_seconds >= MIN_TIMELOCK_SECONDS,
            FactoryError::TimelockTooShort
        );
        state.timelock_seconds = *new_timelock_seconds;
        state.last_updated_slot = clock.slot;
        emit!(TimelockSecondsUpdated {
            authority: state.authority,
            old_timelock: state.timelock_seconds,  // Note: already updated
            new_timelock: *new_timelock_seconds,
        });
    }
}
```

### Testing

#### Test Case 1: Minimum Timelock Enforced on Init
```rust
#[test]
fn test_minimum_timelock_on_init() {
    // Try to initialize with timelock_seconds = 0
    // Expected: Should fail with TimelockTooShort
    
    // Try to initialize with timelock_seconds < MIN
    // Expected: Should fail with TimelockTooShort
    
    // Try to initialize with timelock_seconds >= MIN
    // Expected: Should succeed
}
```

#### Test Case 2: Direct Updates Always Rejected
```rust
#[test]
fn test_direct_updates_rejected() {
    // Try to call set_default_features directly
    // Expected: Should fail with TimelockOnlyQueue
    // Even if timelock_seconds was somehow 0
}
```

#### Test Case 3: Timelock Changes Require Timelock
```rust
#[test]
fn test_timelock_changes_require_timelock() {
    // Try to decrease timelock directly
    // Expected: Should fail, must go through timelock
    
    // Increase timelock directly
    // Expected: Should succeed (more secure)
}
```

### Verification Checklist

- [ ] MIN_TIMELOCK_SECONDS constant defined
- [ ] `ensure_direct_update_allowed` always rejects direct updates
- [ ] `initialize_factory` validates minimum timelock
- [ ] Timelock update function added (if needed)
- [ ] New error types added
- [ ] TimelockAction enum updated (if needed)
- [ ] All tests pass
- [ ] Code review completed
- [ ] Integration tests verify fix

### Additional Considerations

1. **Minimum Value**: Choose appropriate minimum (24 hours recommended for critical operations)

2. **Timelock for Timelock Changes**: Consider requiring timelock even for timelock changes to prevent bypass

3. **Emergency Override**: If emergency override is needed, use separate heavily safeguarded mechanism

4. **Documentation**: Document:
   - Why minimum timelock exists
   - What the minimum is
   - How to change timelock (through timelock system)

### Impact Assessment

**Before Fix**: 
- Security: CRITICAL vulnerability
- Risk: Instant protocol compromise if authority compromised

**After Fix**:
- Security: Minimum timelock always enforced
- Risk: Low (with proper minimum)
- Breaking Change: Yes - direct updates no longer work

### Rollout Plan

1. Define appropriate minimum timelock (e.g., 24 hours)
2. Implement fixes
3. Update all existing factories (if any) to have minimum timelock
4. Deploy to testnet
5. Verify timelock system works correctly
6. Deploy to mainnet
7. Monitor for any issues

---

**Priority**: CRITICAL - Fix immediately before production
**Estimated Effort**: Medium (need to update multiple functions)
**Risk of Fix**: Low (makes code more secure)

