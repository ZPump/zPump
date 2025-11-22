# Authority Change Security

## Severity: CRITICAL

## Description

The vault program implements a timelock-based authority change mechanism. While this provides protection, there are potential vulnerabilities in the implementation that could allow unauthorized authority changes or manipulation.

## Vulnerability Details

### Current Implementation

Authority changes use:
- `propose_authority_change`: Initiates change with 7-day timelock
- `execute_authority_change`: Executes after timelock
- `cancel_authority_change`: Cancels pending change
- Pending change stored in `PendingAuthorityChange` account

### Potential Vulnerabilities

1. **Timelock Bypass**: If the timelock validation is not strict enough, authority changes could execute before the timelock expires.

2. **Pending Change Manipulation**: If the pending change account can be manipulated, the authority change could be modified or executed incorrectly.

3. **Multiple Pending Changes**: The code allows only one pending change at a time (single PDA). If a change is proposed but not executed, new changes might be blocked.

4. **Authority Validation**: When executing, the code validates the current authority matches the pending change, but if the authority has changed (legitimately or not), validation could fail or allow unauthorized execution.

5. **Cancel Authorization**: Only the current authority can cancel, but if the authority is compromised, they could cancel legitimate changes.

6. **Execute Authorization**: Anyone can execute after timelock, which is correct, but there's no additional validation that the change is still desired.

## Exploitation Scenario

```rust
// Scenario 1: Timelock bypass
// 1. Attacker proposes authority change
// 2. Attacker manipulates clock or finds way to bypass timelock check
// 3. Attacker executes change before 7 days
// 4. Attacker gains control of vault

// Scenario 2: Pending change manipulation
// 1. Legitimate authority proposes change to NewAuthority
// 2. Attacker manipulates pending change account
// 3. Attacker changes new_authority to AttackerAuthority
// 4. After timelock, attacker executes and gains control

// Scenario 3: Authority compromise during timelock
// 1. Legitimate authority proposes change
// 2. Authority key is compromised during 7-day timelock
// 3. Attacker cancels legitimate change
// 4. Attacker proposes change to attacker's authority
// 5. After timelock, attacker gains control
```

## Code References

- Authority change proposal: `propose_authority_change` (lines 127-168)
- Authority change execution: `execute_authority_change` (lines 171-210)
- Authority change cancellation: `cancel_authority_change` (lines 213-243)
- Timelock duration: `TIMELOCK_DURATION_SECONDS` constant (line 13)

## Mitigation

1. **Stricter Timelock Validation**: 
   - Use slot-based validation in addition to timestamp
   - Require minimum blocks/slots in addition to time
   - Validate clock is not manipulated

2. **Pending Change Integrity**: 
   - Add hash/checksum to pending change account
   - Validate integrity before execution
   - Make account immutable after proposal

3. **Multi-Step Confirmation**: Require the new authority to confirm acceptance before execution, preventing unauthorized changes.

4. **Change Expiration**: Add expiration to pending changes. If not executed within a reasonable time (e.g., 30 days), automatically cancel.

5. **Change Logging**: Emit detailed events for all authority change operations to enable monitoring and detection of suspicious activity.

6. **Emergency Freeze**: Implement an emergency freeze mechanism that can halt authority changes if suspicious activity is detected.

7. **Authority Change Limits**: Limit the frequency of authority changes (e.g., maximum one per month) to prevent rapid cycling.

8. **New Authority Validation**: Validate that the new authority is a valid program or account before allowing the change.

## Recommended Code Changes

```rust
// Enhanced pending change with integrity
pub struct PendingAuthorityChange {
    // ... existing fields ...
    pub integrity_hash: [u8; 32], // Hash of critical fields
    pub proposed_by: Pubkey, // Who proposed the change
    pub expires_at: i64, // Expiration timestamp
}

// Enhanced proposal with integrity
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_pool_authority: Pubkey,
) -> Result<()> {
    // ... existing validation ...
    
    // Validate new authority is reasonable
    require!(
        new_pool_authority != Pubkey::default(),
        VaultError::InvalidAuthorityChange
    );
    
    // Check rate limiting (max one change per month)
    let clock = Clock::get()?;
    if let Some(last_change) = state.last_authority_change_time {
        require!(
            clock.unix_timestamp >= last_change + 30 * 24 * 60 * 60, // 30 days
            VaultError::AuthorityChangeRateLimited
        );
    }
    
    let pending = &mut ctx.accounts.pending_change;
    // ... set fields ...
    
    // Compute integrity hash
    let hash_input = hashv(&[
        pending.vault_state.as_ref(),
        pending.current_authority.as_ref(),
        pending.new_authority.as_ref(),
        &pending.execute_after.to_le_bytes(),
    ]);
    pending.integrity_hash = hash_input.to_bytes();
    pending.proposed_by = ctx.accounts.authority.key();
    pending.expires_at = execute_after + 30 * 24 * 60 * 60; // 30 days after execution time
    
    Ok(())
}

// Enhanced execution with integrity check
pub fn execute_authority_change(
    ctx: Context<ExecuteAuthorityChange>,
) -> Result<()> {
    // ... existing validation ...
    
    // Verify integrity hash
    let expected_hash = hashv(&[
        pending.vault_state.as_ref(),
        pending.current_authority.as_ref(),
        pending.new_authority.as_ref(),
        &pending.execute_after.to_le_bytes(),
    ]);
    require!(
        expected_hash.to_bytes() == pending.integrity_hash,
        VaultError::IntegrityCheckFailed
    );
    
    // Check expiration
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < pending.expires_at,
        VaultError::ChangeExpired
    );
    
    // Require new authority confirmation (if possible)
    // This would require new authority to sign or call a confirmation function
    
    // ... execute change ...
    
    // Update last change time
    state.last_authority_change_time = Some(clock.unix_timestamp);
    
    Ok(())
}

// New authority confirmation
pub fn confirm_authority_change(
    ctx: Context<ConfirmAuthorityChange>,
) -> Result<()> {
    let pending = &ctx.accounts.pending_change;
    require!(
        ctx.accounts.new_authority.key() == pending.new_authority,
        VaultError::UnauthorizedCaller
    );
    
    // Mark as confirmed
    pending.confirmed = true;
    
    Ok(())
}
```

