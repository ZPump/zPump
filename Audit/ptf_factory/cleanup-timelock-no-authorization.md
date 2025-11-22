# Cleanup Timelock Action Has No Authorization

## Severity: MEDIUM

## Description

The `cleanup_timelock_action` function allows anyone to clean up expired timelock entries without any authorization check. While the cleanup is restricted to entries that are past the grace period and not executed/canceled, the lack of authorization means anyone can collect rent from closing these accounts, potentially incentivizing spam or griefing.

## Vulnerability Details

### Current Implementation

```rust
pub fn cleanup_timelock_action(ctx: Context<CleanupTimelockAction>) -> Result<()> {
    // ... validation of entry state and expiration ...
    // No authorization check - anyone can call this
}
```

The function:
- Validates entry is not executed/canceled (lines 535-536)
- Validates entry is past grace period (lines 545-553)
- Does NOT require any authorization
- Closes account and sends rent to `cleaner` (line 833)

### Potential Vulnerabilities

1. **Rent Collection Incentive**: Anyone can clean up expired entries and collect rent, which could incentivize spam creation of entries just to collect rent later.

2. **Griefing**: Malicious actors could clean up entries before legitimate cleanup, potentially causing confusion or audit trail issues.

3. **No Accountability**: There's no record of who should be allowed to clean up, making it harder to detect abuse.

4. **Race Conditions**: Multiple actors could try to clean up the same entry simultaneously, though only one will succeed.

5. **Economic Attack**: If cleanup is profitable (rent collection), attackers might create many entries just to clean them up later.

## Exploitation Scenario

```rust
// Scenario 1: Rent collection spam
// 1. Attacker creates many timelock entries
// 2. Entries expire after grace period
// 3. Attacker cleans them up and collects rent
// 4. If rent > transaction cost, attacker profits
// 5. System is spammed with entries

// Scenario 2: Griefing
// 1. Legitimate entry expires
// 2. Attacker cleans it up before legitimate cleanup
// 3. Audit trail is disrupted
// 4. Confusion about who cleaned up

// Scenario 3: Economic DoS
// 1. Attacker creates many entries
// 2. Each entry consumes account space
// 3. Factory state grows with pending_action_hashes
// 4. System becomes expensive to use
```

## Code References

- Cleanup function: Lines 531-569
- Account constraint: Lines 820-838
- No authorization check
- Rent goes to `cleaner` (line 833)

## Mitigation

1. **Require Authority**: Require factory authority to clean up:

```rust
#[derive(Accounts)]
pub struct CleanupTimelockAction<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
    // ... other accounts ...
}

pub fn cleanup_timelock_action(ctx: Context<CleanupTimelockAction>) -> Result<()> {
    // Authority is already validated by has_one constraint
    // ... rest of function ...
}
```

2. **Allow Anyone but Track**: If anyone should be able to clean up, at least track who did it and consider rate limiting:

```rust
pub fn cleanup_timelock_action(ctx: Context<CleanupTimelockAction>) -> Result<()> {
    // ... existing validation ...
    
    // Log who cleaned it up for audit
    emit!(TimelockGarbageCollected {
        factory: state.key(),
        action_hash: entry.action_hash,
        cleaner: ctx.accounts.cleaner.key(),
        cleaned_at: clock.unix_timestamp,
        was_authority: ctx.accounts.cleaner.key() == state.authority,
    });
    
    // ... rest of function ...
}
```

3. **Rate Limiting**: Add rate limiting to prevent spam cleanup:

```rust
// Track cleanup operations per cleaner
// Limit number of cleanups per time period
```

4. **Whitelist Cleaners**: Maintain a whitelist of authorized cleaners:

```rust
#[account]
pub struct FactoryState {
    // ... existing fields ...
    pub authorized_cleaners: Vec<Pubkey>,
}

// Check if cleaner is authorized
require!(
    state.authorized_cleaners.contains(&ctx.accounts.cleaner.key()) 
        || ctx.accounts.cleaner.key() == state.authority,
    FactoryError::UnauthorizedCleaner
);
```

5. **Send Rent to Factory**: Instead of sending rent to cleaner, send it to factory or burn it:

```rust
#[account(
    mut,
    // ... other constraints ...
    close = factory_state,  // Send rent to factory instead of cleaner
)]
pub timelock_entry: Account<'info, TimelockEntry>,
```

6. **Add Error Type**: Add error variant for unauthorized cleanup:

```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("cleaner is not authorized")]
    UnauthorizedCleaner,
}
```

Note: While allowing anyone to clean up can be useful for garbage collection, it should be carefully considered and potentially restricted or monitored to prevent abuse.

