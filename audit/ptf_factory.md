# Security Audit Report: ptf_factory

## Program Overview
- **Program ID**: `4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy`
- **Purpose**: Maintains mint-to-pool mappings, twin mint configuration, and factory state
- **Language**: Rust (Anchor framework)

## Critical Security Issues

### 1. CRITICAL: Timelock Bypass for Direct Updates
**Severity**: CRITICAL (9/10)
**Location**: Lines 599-604

**Issue**: When `timelock_seconds` is set to 0, the `ensure_direct_update_allowed` function allows direct updates without going through the timelock system. This completely bypasses the security mechanism.

**Code Reference**:
```rust
fn ensure_direct_update_allowed(state: &FactoryState) -> Result<()> {
    if state.timelock_seconds > 0 {
        return Err(error!(FactoryError::TimelockOnlyQueue));
    }
    Ok(())
}
```

**Why This Is Critical**:
- If timelock is set to 0 (or negative), all timelock protections are disabled
- Authority can make instant changes to:
  - Default features
  - Mint configurations
  - Fee settings
- No way to enforce a minimum timelock period
- A compromised authority can immediately change critical settings

**Recommendation**:
- Enforce a minimum timelock (e.g., 24 hours)
- Never allow direct updates for critical operations
- Require timelock for all state changes, even if short

### 2. HIGH: Timelock Action Hash Can Be Reused
**Severity**: HIGH (7/10)
**Location**: Lines 188-240 (queue_timelock_action)

**Issue**: The timelock system uses a salt to create unique action hashes, but if the same salt is reused with the same action, it could lead to confusion. The system doesn't prevent queuing the same action multiple times with different salts.

**Code Reference**:
```rust
let expected_hash = hashv(&[
    state.key().as_ref(),
    &action_bytes,
    &execute_after.to_le_bytes(),
]);
```

**Why This Is High**:
- Multiple timelock entries can be created for similar actions
- Could lead to confusion about which action to execute
- No deduplication mechanism
- An attacker could spam timelock entries

**Recommendation**:
- Add a nonce or sequence number to prevent duplicate actions
- Consider preventing duplicate actions within a time window
- Add a maximum number of pending timelock actions

### 3. HIGH: Timelock Execution Doesn't Verify Action Hash
**Severity**: HIGH (8/10)
**Location**: Lines 243-322 (execute_timelock_action)

**Issue**: The `execute_timelock_action` function doesn't re-verify that the action hash matches the stored action. It trusts that the action in the timelock entry is correct.

**Code Reference**:
```rust
match &entry.action {
    TimelockAction::SetDefaultFeatures { features } => {
        state.default_features = FeatureFlags::from(*features);
        // ...
    }
    // ...
}
```

**Why This Is High**:
- If the action was tampered with after queuing, it would execute incorrectly
- The hash is computed during queueing but not verified during execution
- Should recompute and verify the hash matches

**Recommendation**:
```rust
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
```

### 4. MEDIUM: Mint Registration Doesn't Check for Duplicates
**Severity**: MEDIUM (6/10)
**Location**: Lines 63-113 (register_mint)

**Issue**: The `register_mint` function uses `init` constraint which will fail if the account already exists, but there's no explicit check or clear error message if someone tries to register the same mint twice.

**Code Reference**:
```rust
#[account(
    init,
    payer = payer,
    seeds = [seeds::MINT_MAPPING, origin_mint.key().as_ref()],
    bump,
    space = MintMapping::SPACE,
)]
pub mint_mapping: Account<'info, MintMapping>,
```

**Why This Is Medium**:
- Anchor's `init` will fail if account exists, but error might be unclear
- Should have explicit check with clear error message
- Could be used for griefing if someone tries to register popular mints

**Recommendation**:
- Add explicit check: `require!(mint_mapping.origin_mint == Pubkey::default(), FactoryError::AlreadyRegistered);`
- Or use `init_if_needed` with proper validation

### 5. MEDIUM: PTKN Mint Authority Transfer Has Race Condition Risk
**Severity**: MEDIUM (6/10)
**Location**: Lines 701-715

**Issue**: When setting PTKN mint authority, the code checks if the current authority matches the factory, and if not, transfers it. However, there's a window where the authority could be changed between the check and the transfer.

**Code Reference**:
```rust
match mint_account.mint_authority {
    COption::Some(current) => {
        if current != factory_state.key() {
            let signer = current_authority.ok_or(FactoryError::Unauthorized)?;
            // Transfer authority...
        }
    }
    COption::None => return err!(FactoryError::PtknAuthorityMissing),
}
```

**Why This Is Medium**:
- In Solana, transactions are atomic, so this is less of an issue
- However, the logic could be clearer
- Should verify the transfer succeeded

**Recommendation**:
- Verify authority after transfer
- Add explicit checks for authority state
- Consider using a two-step process for authority transfers

### 6. MEDIUM: No Maximum Limit on Timelock Seconds
**Severity**: MEDIUM (5/10)
**Location**: initialize_factory, timelock usage

**Issue**: There's no maximum limit on `timelock_seconds`. While unlikely, setting an extremely large value (e.g., 100 years) could effectively lock the factory forever.

**Recommendation**:
- Add a maximum timelock (e.g., 30 days)
- Validate on initialization and updates

### 7. LOW: Pause Doesn't Prevent All Operations
**Severity**: LOW (4/10)
**Location**: Lines 170-186

**Issue**: The pause function stops `register_mint` and `update_mint`, but `mint_ptkn` still works when paused. This might be intentional, but should be documented.

**Code Reference**:
```rust
pub fn mint_ptkn(ctx: Context<MintPtkn>, amount: u64) -> Result<()> {
    // ...
    require!(!factory_state.paused, FactoryError::Paused);
    // ...
}
```

Actually, `mint_ptkn` does check for pause. But other operations might not.

**Recommendation**:
- Document which operations are affected by pause
- Consider if all operations should be paused or just some

### 8. LOW: Missing Input Validation
**Severity**: LOW (3/10)

**Issue**: Some functions don't validate all inputs thoroughly (e.g., decimals, fee_bps ranges).

**Recommendation**:
- Add comprehensive input validation
- Check all numeric ranges
- Validate Pubkey formats

## Positive Security Features

1. **Timelock System**: Good implementation of timelock for critical operations
2. **Pause Mechanism**: Ability to pause operations in emergencies
3. **Mint Status Tracking**: Tracks active/frozen status for mints
4. **Fee Validation**: Validates fee_bps doesn't exceed MAX_BPS
5. **PDA Usage**: Proper use of PDAs for state accounts

## Recommendations Summary

1. **CRITICAL**: Enforce minimum timelock, never allow direct updates
2. **HIGH PRIORITY**: Verify action hash during timelock execution
3. **HIGH PRIORITY**: Add deduplication for timelock actions
4. **MEDIUM PRIORITY**: Add explicit duplicate check for mint registration
5. **MEDIUM PRIORITY**: Add maximum timelock limit
6. **MEDIUM PRIORITY**: Strengthen PTKN authority transfer logic
7. **LOW PRIORITY**: Document pause behavior
8. **LOW PRIORITY**: Add comprehensive input validation

## Overall Security Score: 6.5/10

The factory has good security features (timelock, pause), but critical issues around timelock bypass and hash verification need immediate attention.

