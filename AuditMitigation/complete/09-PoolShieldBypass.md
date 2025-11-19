# Mitigation: Shield Finalization Can Still Be Bypassed in Edge Cases

## Severity: HIGH
## Contract: ptf_pool
## Issue ID: 9

## Problem Description

The code detects stuck states and deactivates pending_shield, but this could allow a new shield to proceed even if the previous one is still valid but not yet finalized. The logic at lines 684-693 only rejects if claim is not stale, but there's a race condition window.

## Security Impact

1. **Potential for duplicate shields** - Two shields could proceed if timing is right
2. **State inconsistency** - Pending shield state could be incorrect
3. **Double-spending risk** - Could deposit twice if finalization is skipped

## Mitigation

Add explicit timeout check before allowing new shield:

```rust
pub const SHIELD_CLAIM_TIMEOUT_SLOTS: u64 = 100; // ~50 seconds at 500ms/slot

pub fn shield<'info>(
    ctx: Context<'_, '_, '_, 'info, Shield<'info>>,
    args: ShieldArgs,
) -> Result<()> {
    // ... existing code ...
    
    // Check if there's an active shield claim that needs finalization
    let has_active_claim = ctx.accounts.shield_claim.is_active();
    
    if has_active_claim {
        let commitment_tree = load_commitment_tree()?;
        let claim_old_root = ctx.accounts.shield_claim.old_root;
        let tree_current_root = commitment_tree.current_root;
        
        // CRITICAL FIX: Check if claim is stale based on explicit timeout
        let clock = Clock::get()?;
        let claim_age = clock.slot.saturating_sub(ctx.accounts.shield_claim.created_slot);
        
        // Only reject if claim is NOT stale AND root matches (could be finalized)
        if claim_age < SHIELD_CLAIM_TIMEOUT_SLOTS && claim_old_root == tree_current_root {
            return err!(PoolError::PendingShieldInFlight);
        }
        
        // If claim is stale (timeout exceeded), deactivate it
        if claim_age >= SHIELD_CLAIM_TIMEOUT_SLOTS {
            msg!("shield: claim timeout exceeded, deactivating stale claim");
            ctx.accounts.shield_claim.deactivate();
            pool_state.pending_shield.deactivate();
        }
    }
    
    // ... rest of function
}
```

## Additional Safeguard

Track shield attempts per depositor to prevent rapid duplicate shields:

```rust
// In ShieldClaim struct, add:
pub depositor: Pubkey,
pub created_slot: u64,

// In shield function:
if has_active_claim {
    // If same depositor tries to shield again with same root, reject immediately
    if ctx.accounts.shield_claim.depositor == ctx.accounts.payer.key() 
        && ctx.accounts.shield_claim.old_root == pool_state.current_root {
        let clock = Clock::get()?;
        let claim_age = clock.slot.saturating_sub(ctx.accounts.shield_claim.created_slot);
        
        // Require minimum time between shields from same depositor
        if claim_age < SHIELD_CLAIM_TIMEOUT_SLOTS {
            return err!(PoolError::PendingShieldInFlight);
        }
    }
}
```

## Recommended

Implement explicit timeout check as primary fix, with depositor check as additional safeguard.

## References

- Issue location: `programs/pool/src/lib.rs:655-699`
- Shield claim activation: `programs/pool/src/lib.rs:879-897`
- Stuck state detection: `programs/pool/src/lib.rs:655-680`

