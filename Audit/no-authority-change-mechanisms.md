# No Authority Change Mechanisms

## Severity: CRITICAL

## Description

Multiple contracts (`ptf_factory`, `ptf_pool`) have no mechanism to change their authority after initialization. If the authority key is compromised, lost, or needs to be rotated for security reasons, there is no way to recover or update it. This creates permanent single points of failure that can lead to complete system compromise or permanent lockout.

## Affected Contracts

1. **ptf_factory**: No way to change factory authority (CRITICAL)
2. **ptf_pool**: No way to change pool authority (HIGH)

## Vulnerability Pattern

### Current Anti-Pattern

```rust
// ptf_factory/src/lib.rs
pub fn initialize_factory(
    ctx: Context<InitializeFactory>,
    authority: Pubkey,
    // ... other params ...
) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    state.authority = authority;  // Set once, never changeable
    // ... no update mechanism ...
}

// ptf_pool/src/lib.rs
pub fn initialize_pool(
    ctx: Context<InitializePool>,
    fee_bps: u16,
    features: u8,
) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    pool_state.authority = ctx.accounts.authority.key();  // Set once, never changeable
    // ... no update mechanism ...
}
```

### Why This Is Critical

1. **Key Compromise**: If authority key is compromised, attacker has permanent control
2. **Key Loss**: If authority key is lost, system becomes permanently ungovernable
3. **No Recovery**: There is no way to recover from either scenario
4. **Key Rotation Impossible**: Security best practices require periodic key rotation
5. **Single Point of Failure**: Single authority key is a critical vulnerability

## Specific Instances

### ptf_factory - Factory Authority

**Severity**: CRITICAL
**Location**: `initialize_factory` instruction
**Authority Powers**:
- Pause/unpause the factory
- Freeze/thaw mint mappings
- Register new mints
- Create verifying keys
- Queue timelock actions
- Cancel timelock actions

**Impact**: If compromised, attacker can:
1. Pause entire factory, freezing all operations
2. Register malicious mints
3. Create malicious verifying keys
4. Cancel legitimate timelock actions
5. Freeze/thaw mints arbitrarily

**Reference**: `Audit/ptf_factory/no-authority-change-mechanism.md`

### ptf_pool - Pool Authority

**Severity**: HIGH
**Location**: `initialize_pool` instruction
**Authority Powers**:
- Set fees (`set_fee`)
- Set features (`set_features`)
- Configure hooks (`configure_hooks`)
- Manage hook whitelist (`add_hook`, `remove_hook`)

**Impact**: If compromised, attacker can:
1. Set fees to 100%, draining users
2. Disable critical features
3. Configure malicious hooks
4. Add malicious programs to whitelist

**Reference**: `Audit/ptf_pool/no-authority-change-mechanism.md`

## Exploitation Scenarios

### Scenario 1: Key Compromise

```rust
// 1. Authority private key is compromised (phishing, malware, insider threat)
// 2. Attacker gains full control of factory/pool
// 3. Attacker can:
//    - Pause system (DoS)
//    - Register malicious mints
//    - Create malicious verifying keys
//    - Change fees to 100% (drain users)
//    - Configure malicious hooks
// 4. No way to recover or change authority
// 5. System is permanently compromised
```

### Scenario 2: Key Loss

```rust
// 1. Authority key is lost (hardware failure, accidental deletion, forgotten)
// 2. System cannot be managed:
//    - Cannot update fees
//    - Cannot change features
//    - Cannot configure hooks
//    - Cannot respond to incidents
// 3. No recovery mechanism
// 4. System becomes permanently ungovernable
```

### Scenario 3: Key Rotation Required

```rust
// 1. Security audit requires key rotation
// 2. Compliance requirements mandate periodic rotation
// 3. No mechanism to rotate authority
// 4. System cannot meet security requirements
// 5. Compliance cannot be achieved
```

## Root Cause Analysis

### Design Decisions

1. **Simplicity**: Single authority is simpler than multi-sig or governance
2. **Trust Model**: Assumes authority key will be kept secure
3. **Early Development**: Authority change wasn't considered in initial design
4. **Security Through Obscurity**: Assumes key won't be compromised

### Why This Fails

1. **Key Compromise Is Common**: Phishing, malware, and insider threats are real risks
2. **Key Loss Happens**: Hardware failures, accidents, and human error occur
3. **Security Best Practices**: Key rotation is a standard security practice
4. **Regulatory Requirements**: Many regulations require key rotation capabilities
5. **Recovery Needs**: Systems need recovery mechanisms for incidents

## Mitigation Strategy

### 1. Add Authority Change via Timelock (Factory)

```rust
// ptf_factory/src/lib.rs
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    // ... existing actions ...
    ChangeAuthority {
        new_authority: Pubkey,
    },
}

pub fn execute_timelock_action(
    ctx: Context<ExecuteTimelockAction>,
    action_hash: [u8; 32],
) -> Result<()> {
    // ... existing validation ...
    
    match &entry.action {
        // ... existing actions ...
        TimelockAction::ChangeAuthority { new_authority } => {
            // Validate new authority is not default
            require!(
                new_authority != &Pubkey::default(),
                FactoryError::InvalidAuthority
            );
            
            // Validate new authority is different
            require!(
                new_authority != &state.authority,
                FactoryError::AuthorityUnchanged
            );
            
            let old_authority = state.authority;
            state.authority = *new_authority;
            
            emit!(AuthorityChanged {
                old_authority,
                new_authority: *new_authority,
                changed_by: state.authority,  // Note: this is the old one
            });
        }
    }
    
    // ... rest of function ...
}
```

### 2. Add Direct Authority Change (Pool)

```rust
// ptf_pool/src/lib.rs
pub fn change_authority(
    ctx: Context<ChangeAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    
    // Validate current authority
    require_keys_eq!(
        ctx.accounts.current_authority.key(),
        pool_state.authority,
        PoolError::Unauthorized
    );
    
    // Validate new authority is not default
    require!(
        new_authority != Pubkey::default(),
        PoolError::InvalidAuthority
    );
    
    // Validate new authority is different
    require!(
        new_authority != pool_state.authority,
        PoolError::AuthorityUnchanged
    );
    
    // Update authority
    let old_authority = pool_state.authority;
    pool_state.authority = new_authority;
    
    // Update hook whitelist authority if it exists
    if let Ok(mut hook_whitelist) = ctx.accounts.hook_whitelist.try_load_mut() {
        hook_whitelist.authority = new_authority;
    }
    
    emit!(AuthorityChanged {
        origin_mint: pool_state.origin_mint,
        old_authority,
        new_authority,
    });
    
    Ok(())
}

#[derive(Accounts)]
pub struct ChangeAuthority<'info> {
    pub current_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::POOL, pool_state.load()?.origin_mint.as_ref()],
        bump = pool_state.load()?.bump,
        has_one = authority @ PoolError::Unauthorized
    )]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(mut)]
    pub hook_whitelist: Option<Account<'info, HookWhitelist>>,
}
```

### 3. Use Timelock for Pool (Recommended)

```rust
// ptf_pool/src/lib.rs
// Similar to factory, implement timelock-based authority change
pub fn propose_authority_change(
    ctx: Context<ProposeAuthorityChange>,
    new_authority: Pubkey,
) -> Result<()> {
    // Queue authority change through timelock
    // Similar to factory's timelock mechanism
}
```

### 4. Multi-Signature Authority (Advanced)

```rust
// Consider multi-sig authority instead of single authority
#[account]
pub struct MultiSigAuthority {
    pub threshold: u8,
    pub signers: Vec<Pubkey>,
    pub bump: u8,
}

pub fn change_authority_multi_sig(
    ctx: Context<ChangeAuthorityMultiSig>,
    new_authority: Pubkey,
) -> Result<()> {
    // Require threshold signatures
    // Update authority
}
```

### 5. Emergency Recovery Mechanism

```rust
// Emergency recovery for extreme cases
pub fn emergency_authority_change(
    ctx: Context<EmergencyAuthorityChange>,
    new_authority: Pubkey,
) -> Result<()> {
    // Require multiple confirmations
    // Require longer timelock
    // Require additional validation
    // Update authority
}
```

## Implementation Plan

### Phase 1: Factory Authority Change

1. Add `ChangeAuthority` to `TimelockAction` enum
2. Implement execution logic in `execute_timelock_action`
3. Add longer timelock period for authority changes (e.g., 7 days)
4. Add events and validation

### Phase 2: Pool Authority Change

1. Add `change_authority` instruction
2. Add account structure
3. Update hook whitelist authority when pool authority changes
4. Add events and validation

### Phase 3: Testing and Verification

1. Test authority change flows
2. Test edge cases (default authority, same authority, etc.)
3. Test hook whitelist updates
4. Verify no regressions

### Phase 4: Documentation and Monitoring

1. Document authority change process
2. Add monitoring for authority change attempts
3. Create runbooks for key rotation
4. Add alerts for authority changes

## Recommended Code Standards

1. **Always Allow Authority Changes**: All contracts should support authority changes
2. **Use Timelock for Critical Changes**: Authority changes should go through timelock
3. **Longer Timelock Period**: Authority changes should have longer timelock than other actions
4. **Multi-Step Process**: Consider requiring multiple confirmations for authority changes
5. **Monitoring**: Log and monitor all authority change attempts

## Impact Assessment

- **Security**: CRITICAL - Single point of failure with no recovery
- **Maintainability**: HIGH - System becomes unmanageable if key is lost
- **Compliance**: HIGH - Many regulations require key rotation capabilities
- **Recovery**: CRITICAL - No way to recover from key compromise or loss
- **Flexibility**: MEDIUM - Cannot adapt to changing security requirements

## Conclusion

The lack of authority change mechanisms is a critical design flaw that creates permanent single points of failure. This pattern should be systematically addressed by implementing timelock-based authority changes in all contracts. The fix is essential for long-term security and maintainability, and should be prioritized as a critical security improvement.

