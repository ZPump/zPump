# Hardcoded Program IDs

## Severity: HIGH

## Description

Multiple contracts hardcode program IDs as constants, preventing program upgrades, multi-instance support, and deployment flexibility. This design flaw creates systemic issues where programs cannot be upgraded or migrated without breaking the entire system.

## Affected Contracts

1. **ptf_factory**: Hardcodes `PTF_POOL_PROGRAM_ID`
2. **ptf_verifier_groth16**: Hardcodes `PTF_FACTORY_PROGRAM_ID`

## Vulnerability Pattern

### Current Anti-Pattern

```rust
// ptf_factory/src/lib.rs
const PTF_POOL_PROGRAM_ID: Pubkey = pubkey!("7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh");

// ptf_verifier_groth16/src/lib.rs
const PTF_FACTORY_PROGRAM_ID: Pubkey = pubkey!("4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy");
```

These constants are used for:
- Validating account ownership
- Deriving PDAs
- CPI calls
- Authority validation

### Why This Is Dangerous

1. **No Upgrade Path**: If a program is upgraded and gets a new program ID, dependent programs break
2. **No Multi-Instance Support**: Cannot support multiple instances (testnet/mainnet, different versions)
3. **Deployment Inflexibility**: Hard to deploy to different environments or test with mocks
4. **Migration Impossible**: Cannot migrate to new program IDs for security or other reasons
5. **Testing Limitations**: Hard to test with mock programs or different implementations

## Specific Instances

### ptf_factory - Pool Program ID

**Location**: `mint_ptkn` instruction
**Usage**: Validates pool authority and derives pool PDA
**Impact**: If pool program is upgraded, `mint_ptkn` breaks, preventing PTKN minting
**Reference**: `Audit/ptf_factory/hardcoded-pool-program-id.md`

**Code**:
```rust
const PTF_POOL_PROGRAM_ID: Pubkey = pubkey!("7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh");

// Used in mint_ptkn:
let (expected_pool, _) = Pubkey::find_program_address(
    &[seeds::POOL, mapping.origin_mint.as_ref()],
    &PTF_POOL_PROGRAM_ID,  // Hardcoded
);
require_keys_eq!(
    *ctx.accounts.pool_authority.owner,
    PTF_POOL_PROGRAM_ID,  // Hardcoded
    FactoryError::PoolAuthorityMismatch
);
```

### ptf_verifier_groth16 - Factory Program ID

**Location**: `initialize_verifying_key` instruction
**Usage**: Validates factory authority and derives factory PDA
**Impact**: If factory program is upgraded, key registration breaks
**Reference**: `Audit/ptf_verifier_groth16/hardcoded-factory-program-id.md`

**Code**:
```rust
const PTF_FACTORY_PROGRAM_ID: Pubkey = pubkey!("4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy");

// Used in initialize_verifying_key:
require_keys_eq!(
    *ctx.accounts.authority.owner,
    PTF_FACTORY_PROGRAM_ID,  // Hardcoded
    VerifierError::UnauthorizedAuthority
);

let (expected_factory_state, _) = Pubkey::find_program_address(
    &[b"factory", PTF_FACTORY_PROGRAM_ID.as_ref()],  // Hardcoded
    &PTF_FACTORY_PROGRAM_ID,  // Hardcoded
);
```

## Exploitation Scenarios

### Scenario 1: Program Upgrade Breaks System

```rust
// 1. Pool program is upgraded to fix critical bug
// 2. New pool gets new program ID
// 3. Factory still expects old program ID
// 4. All mint_ptkn calls fail
// 5. PTKN minting becomes unusable
// 6. System is broken until factory is upgraded
```

### Scenario 2: Multi-Environment Deployment

```rust
// 1. System needs to support testnet and mainnet
// 2. Programs have different IDs on each network
// 3. Hardcoded IDs only work for one network
// 4. System cannot support multiple environments
// 5. Deployment becomes complex and error-prone
```

### Scenario 3: Security Incident Recovery

```rust
// 1. Factory program is compromised
// 2. New secure factory is deployed with new ID
// 3. Verifier still expects old factory ID
// 4. Key registration fails
// 5. System remains broken until verifier is upgraded
// 6. Recovery is slow and complex
```

### Scenario 4: Testing Limitations

```rust
// 1. Developer wants to test with mock programs
// 2. Mock programs have different IDs
// 3. Hardcoded IDs prevent using mocks
// 4. Testing becomes difficult
// 5. Bugs might not be caught before deployment
```

## Root Cause Analysis

### Design Decisions

1. **Simplicity**: Hardcoding IDs is simpler than dynamic configuration
2. **Security**: Hardcoded IDs prevent accidental use of wrong programs
3. **Performance**: Constants are faster than reading from state
4. **Early Development**: Hardcoded IDs are common in early development

### Why This Fails

1. **Upgrade Requirements**: Programs need to be upgraded for bugs and features
2. **Multi-Instance Needs**: Production systems often need multiple instances
3. **Deployment Flexibility**: Different environments need different configurations
4. **Security Incidents**: Compromised programs need to be replaced
5. **Testing Needs**: Development requires flexible program IDs

## Mitigation Strategy

### 1. Store Program IDs in State

```rust
// ptf_factory/src/lib.rs
#[account]
pub struct FactoryState {
    // ... existing fields ...
    pub pool_program_id: Pubkey,
}

pub fn initialize_factory(
    ctx: Context<InitializeFactory>,
    authority: Pubkey,
    default_fee_bps: u16,
    timelock_seconds: i64,
    pool_program_id: Pubkey,  // Pass as parameter
) -> Result<()> {
    let state = &mut ctx.accounts.factory_state;
    state.pool_program_id = pool_program_id;
    // ... rest of initialization ...
}

pub fn mint_ptkn(ctx: Context<MintPtkn>, amount: u64) -> Result<()> {
    let factory_state = ctx.accounts.factory_state.load()?;
    
    // Use stored ID instead of constant
    let (expected_pool, _) = Pubkey::find_program_address(
        &[seeds::POOL, mapping.origin_mint.as_ref()],
        &factory_state.pool_program_id,  // From state
    );
    
    require_keys_eq!(
        *ctx.accounts.pool_authority.owner,
        factory_state.pool_program_id,  // From state
        FactoryError::PoolAuthorityMismatch
    );
    
    // ... rest of function ...
}
```

### 2. Allow Updates Through Timelock

```rust
// ptf_factory/src/lib.rs
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    // ... existing actions ...
    UpdatePoolProgramId {
        new_pool_program_id: Pubkey,
    },
}

// In execute_timelock_action:
match &entry.action {
    // ... existing actions ...
    TimelockAction::UpdatePoolProgramId { new_pool_program_id } => {
        // Validate new program ID is a valid program account
        require!(
            ctx.accounts.new_pool_program.executable,
            FactoryError::InvalidProgramId
        );
        
        state.pool_program_id = *new_pool_program_id;
        emit!(PoolProgramIdUpdated {
            old_id: state.pool_program_id,  // Note: before update
            new_id: *new_pool_program_id,
        });
    }
}
```

### 3. Use Configuration Accounts

```rust
// ptf_verifier_groth16/src/lib.rs
#[account]
pub struct VerifierConfig {
    pub factory_program_id: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
}

pub fn initialize_verifier_config(
    ctx: Context<InitializeVerifierConfig>,
    factory_program_id: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.factory_program_id = factory_program_id;
    config.authority = ctx.accounts.authority.key();
    config.bump = ctx.bumps.config;
    Ok(())
}

pub fn update_factory_program_id(
    ctx: Context<UpdateFactoryProgramId>,
    new_factory_program_id: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.config.authority,
        VerifierError::Unauthorized
    );
    
    // Validate new program ID
    require!(
        ctx.accounts.new_factory_program.executable,
        VerifierError::InvalidProgramId
    );
    
    ctx.accounts.config.factory_program_id = new_factory_program_id;
    Ok(())
}

pub fn initialize_verifying_key(
    ctx: Context<InitializeVerifyingKey>,
    // ... params ...
) -> Result<()> {
    let config = &ctx.accounts.verifier_config;
    
    // Use config instead of constant
    require_keys_eq!(
        *ctx.accounts.authority.owner,
        config.factory_program_id,  // From config
        VerifierError::UnauthorizedAuthority
    );
    
    let (expected_factory_state, _) = Pubkey::find_program_address(
        &[b"factory", config.factory_program_id.as_ref()],  // From config
        &config.factory_program_id,  // From config
    );
    
    // ... rest of function ...
}
```

### 4. Migration Support

```rust
// Helper function to migrate program IDs
pub fn migrate_program_id(
    old_id: Pubkey,
    new_id: Pubkey,
) -> Result<()> {
    // Validate migration is authorized
    // Update all references
    // Emit events
    // Handle edge cases
}
```

## Implementation Plan

### Phase 1: Add Program ID Fields to State

1. Add `pool_program_id` to `FactoryState`
2. Create `VerifierConfig` account for verifier
3. Update initialization functions to accept program IDs

### Phase 2: Replace Hardcoded Constants

1. Replace all uses of hardcoded constants with state reads
2. Update PDA derivations to use state values
3. Update validation logic

### Phase 3: Add Update Mechanisms

1. Add timelock actions for updating program IDs
2. Add direct update functions with proper authorization
3. Add validation for new program IDs

### Phase 4: Migration and Testing

1. Create migration scripts for existing deployments
2. Test program ID updates
3. Verify backward compatibility

## Recommended Code Standards

1. **No Hardcoded Program IDs**: All program IDs should be stored in state or passed as parameters
2. **Configuration Accounts**: Use dedicated configuration accounts for program IDs
3. **Update Mechanisms**: Provide authorized ways to update program IDs
4. **Validation**: Always validate program IDs are executable accounts
5. **Events**: Emit events when program IDs are updated

## Impact Assessment

- **Security**: HIGH - Prevents recovery from security incidents
- **Maintainability**: HIGH - Makes upgrades and migrations difficult
- **Flexibility**: HIGH - Prevents multi-instance and multi-environment support
- **Testing**: MEDIUM - Makes testing with mocks difficult
- **Performance**: LOW - Reading from state has minimal overhead

## Conclusion

Hardcoded program IDs are a critical design flaw that prevents program upgrades, multi-instance support, and deployment flexibility. This pattern should be systematically replaced with state-based configuration that allows authorized updates. The fix requires changes to multiple contracts but is essential for long-term maintainability and security.

