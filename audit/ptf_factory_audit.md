# Security Audit Report: ptf_factory

**Program ID:** `4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy`  
**Audit Date:** 2025-11-16  
**Severity Grade:** **C (Moderate)**

## Executive Summary

The `ptf_factory` program manages mint registration, configuration, and governance for the privacy pool system. While the program itself has relatively few security issues, it has a **critical design flaw** where the freeze mechanism it implements is not enforced by the pool program, rendering it ineffective. The program also has some moderate issues around authority management and timelock implementation.

## Critical Issues

### CRITICAL-001: Freeze Mechanism Not Enforced by Pool

**Severity:** Critical (Design Flaw)  
**Location:** `programs/factory/src/lib.rs:150-167`

**Description:**
The factory program provides `freeze_mapping` and `thaw_mapping` functions that set `mint_mapping.status` to `Frozen` or `Active`:

```rust
pub fn freeze_mapping(ctx: Context<MutationMintState>) -> Result<()> {
    let mapping = &mut ctx.accounts.mint_mapping;
    mapping.status = MintStatus::Frozen as u8;
    emit!(MintFrozen {
        origin_mint: mapping.origin_mint,
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}

pub fn thaw_mapping(ctx: Context<MutationMintState>) -> Result<()> {
    let mapping = &mut ctx.accounts.mint_mapping;
    mapping.status = MintStatus::Active as u8;
    emit!(MintThawed {
        origin_mint: mapping.origin_mint,
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}
```

**Vulnerability:**
- The factory correctly sets the status
- However, the **pool program never checks this status** (see `ptf_pool_audit.md` CRITICAL-002)
- Freezing a mint has no effect - users can still shield, transfer, and unshield
- The freeze mechanism is completely ineffective

**Impact:**
- **Governance mechanism broken** - Cannot effectively freeze compromised mints
- **Emergency response ineffective** - Cannot stop attacks on compromised assets
- **Regulatory compliance impossible** - Cannot enforce sanctions or freezes
- **False sense of security** - Appears to work but doesn't

**Recommended Fix:**
This is a **design issue** that requires coordination between factory and pool:

1. **Factory side (this program):** No changes needed - it correctly sets status
2. **Pool side:** Must check status before processing transactions (see `ptf_pool_audit.md`)
3. **Coordination:** Both programs must be updated together

**Note:** This is documented in the pool audit as CRITICAL-002. The factory program itself is correct, but the system design is flawed.

## Moderate Issues

### MOD-001: Authority Management

**Severity:** Moderate  
**Location:** `programs/factory/src/lib.rs:23-45, 410-415`

**Description:**
The factory uses a single `authority` account for all administrative functions. There's no multi-sig, timelock for authority changes, or role-based access control.

**Vulnerability:**
- Single point of failure - if authority key is compromised, entire system is compromised
- No separation of duties - same authority can freeze, pause, update mints, etc.
- Authority changes are immediate with no timelock

**Impact:**
- **Single point of failure** - Compromised authority = compromised system
- **No defense in depth** - All power concentrated in one key
- **Immediate changes** - No time to detect and respond to unauthorized changes

**Recommended Fix:**
1. Implement multi-sig authority (e.g., 2-of-3, 3-of-5)
2. Add timelock for authority changes
3. Consider role-based access (separate keys for freeze, pause, update, etc.)
4. Add events/logging for all authority actions

### MOD-002: Timelock Bypass for Direct Updates

**Severity:** Moderate  
**Location:** `programs/factory/src/lib.rs:599-604`

**Description:**
The factory has a timelock mechanism, but it can be bypassed if `timelock_seconds == 0`:

```rust
fn ensure_direct_update_allowed(state: &FactoryState) -> Result<()> {
    if state.timelock_seconds > 0 {
        return Err(error!(FactoryError::TimelockOnlyQueue));
    }
    Ok(())
}
```

**Vulnerability:**
- If `timelock_seconds` is set to 0 during initialization, all updates are immediate
- No protection against rapid changes
- Authority can change `timelock_seconds` to 0 to bypass timelock

**Impact:**
- **Timelock can be disabled** - Defeats the purpose of timelock
- **No protection** - Changes can be made immediately
- **Governance bypass** - Can circumvent intended delays

**Recommended Fix:**
1. Require minimum timelock (e.g., at least 24 hours)
2. Add timelock for `timelock_seconds` changes themselves
3. Consider making timelock immutable after initialization
4. Document the security implications of `timelock_seconds == 0`

### MOD-003: Pause Mechanism Scope

**Severity:** Moderate  
**Location:** `programs/factory/src/lib.rs:170-186`

**Description:**
The factory has `pause()` and `unpause()` functions that prevent new mint registrations:

```rust
pub fn pause(ctx: Context<UpdateFactoryAuthority>) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    state.paused = true;
    emit!(FactoryPaused {
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}
```

**Vulnerability:**
- Pause only affects `register_mint` - existing pools continue operating
- Cannot pause individual mints, only the entire factory
- No emergency stop for compromised pools

**Impact:**
- **Limited scope** - Cannot stop individual compromised pools
- **All-or-nothing** - Must pause entire factory to stop one mint
- **No granular control** - Cannot selectively disable specific mints

**Recommended Fix:**
1. Consider adding per-mint pause mechanism
2. Coordinate with pool program to respect factory pause
3. Add emergency stop mechanism that affects existing pools

## Additional Security Observations

### OBS-001: Mint Registration Validation

**Location:** `programs/factory/src/lib.rs:63-113`

The factory correctly validates:
- Decimals <= 12
- Fee BPS <= MAX_BPS
- Factory not paused
- Proper account relationships

No issues found.

### OBS-002: PTKN Mint Authority

**Location:** `programs/factory/src/lib.rs:339-392`

The `mint_ptkn` function correctly verifies:
- Pool authority is a signer
- Pool authority is owned by pool program
- Pool authority matches expected PDA

This is good security practice.

### OBS-003: Timelock Implementation

**Location:** `programs/factory/src/lib.rs:188-337`

The timelock mechanism is well-implemented:
- Proper hash verification
- Time-based execution
- Cancellation mechanism
- Prevents replay attacks

Good implementation, but see MOD-002 for bypass issue.

### OBS-004: Event Emissions

**Location:** Throughout

The factory emits comprehensive events for all state changes. This is good for monitoring and auditing.

## Recommendations

### High Priority

1. **CRITICAL:** Coordinate with pool program to enforce mint status (see CRITICAL-001)
2. **HIGH:** Implement multi-sig authority or role-based access control
3. **HIGH:** Add minimum timelock requirement or make timelock immutable

### Medium Priority

1. Add comprehensive integration tests
2. Add tests for timelock mechanism
3. Add tests for pause/unpause
4. Add tests for freeze/thaw (coordinate with pool tests)

### Low Priority

1. Consider adding per-mint pause mechanism
2. Add monitoring/alerting for authority actions
3. Document security assumptions and threat model

## Testing Recommendations

1. **Freeze/Thaw Test:**
   - Freeze a mint
   - Verify pool rejects transactions (requires pool fix)
   - Thaw the mint
   - Verify pool accepts transactions again

2. **Timelock Test:**
   - Queue a timelock action
   - Attempt to execute before time - should fail
   - Wait for timelock period
   - Execute - should succeed

3. **Pause Test:**
   - Pause factory
   - Attempt to register mint - should fail
   - Unpause factory
   - Register mint - should succeed

4. **Authority Test:**
   - Verify only authority can perform administrative functions
   - Test unauthorized access attempts

## Conclusion

The `ptf_factory` program is relatively well-implemented but has a **critical design flaw** where the freeze mechanism it provides is not enforced by the pool program, making it ineffective. The program also has moderate issues around authority management and timelock bypass. These issues should be addressed, but the most critical fix requires coordination with the pool program to enforce mint status checks.

**Key Takeaway:** The factory program itself is mostly secure, but the system design has flaws that require fixes in both factory and pool programs.

