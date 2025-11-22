# Hardcoded Pool Program ID

## Severity: MEDIUM

## Description

The factory program hardcodes the pool program ID as a constant. If the pool program is upgraded, redeployed with a new program ID, or if there's a need to support multiple pool instances, the factory will be unable to work with the new pool, breaking the `mint_ptkn` functionality.

## Vulnerability Details

### Current Implementation

```rust
const PTF_POOL_PROGRAM_ID: Pubkey = pubkey!("7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh");
```

This constant is used to:
- Validate pool authority in `mint_ptkn` (lines 608-625)
- Derive expected pool PDA (line 610)

### Potential Vulnerabilities

1. **Pool Upgrade Incompatibility**: If the pool program is upgraded and gets a new program ID, `mint_ptkn` will reject all requests, breaking PTKN minting.

2. **Multi-Pool Support**: If the system needs to support multiple pool instances or versions, the hardcoded ID prevents this.

3. **Deployment Flexibility**: Hardcoded IDs reduce deployment flexibility and make it harder to test or deploy to different environments.

4. **Program Migration**: If the pool needs to be migrated to a new program ID (e.g., due to security issues), the factory cannot be easily updated.

5. **Testing Limitations**: Hardcoded IDs make it difficult to test with mock pools or different pool implementations.

## Exploitation Scenario

```rust
// Scenario 1: Pool upgrade breaks factory
// 1. Pool program is upgraded to new version
// 2. New pool gets new program ID
// 3. Factory still expects old program ID
// 4. All mint_ptkn calls fail
// 5. PTKN minting becomes unusable

// Scenario 2: Multi-environment deployment
// 1. System needs to support testnet and mainnet pools
// 2. Pools have different program IDs
// 3. Factory can only work with one
// 4. System cannot support multiple environments

// Scenario 3: Pool compromise
// 1. Pool program is compromised
// 2. New secure pool is deployed with new ID
// 3. Factory cannot work with new pool
// 4. System remains broken until factory is upgraded
```

## Code References

- Hardcoded pool ID: Line 17
- Pool authority validation: Lines 608-625
- PDA derivation: Line 610

## Mitigation

1. **Store Pool ID in Factory State**: Store the pool program ID in factory state:

```rust
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
    pool_program_id: Pubkey,
) -> Result<()> {
    // ... existing code ...
    state.pool_program_id = pool_program_id;
    // ... rest of initialization ...
}
```

2. **Use Stored ID in mint_ptkn**: Read pool ID from factory state:

```rust
pub fn mint_ptkn(ctx: Context<MintPtkn>, amount: u64) -> Result<()> {
    // ... existing checks ...
    
    let (expected_pool, _) = Pubkey::find_program_address(
        &[seeds::POOL, mapping.origin_mint.as_ref()],
        &factory_state.pool_program_id,  // Use stored ID
    );
    
    require_keys_eq!(
        *ctx.accounts.pool_authority.owner,
        factory_state.pool_program_id,  // Use stored ID
        FactoryError::PoolAuthorityMismatch
    );
    
    // ... rest of function ...
}
```

3. **Add Update Mechanism**: Allow updating pool program ID through timelock:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    // ... existing actions ...
    UpdatePoolProgramId {
        new_pool_program_id: Pubkey,
    },
}

// In execute_timelock_action:
TimelockAction::UpdatePoolProgramId { new_pool_program_id } => {
    state.pool_program_id = new_pool_program_id;
    emit!(PoolProgramIdUpdated {
        new_pool_program_id,
        updated_by: state.authority,
    });
}
```

4. **Migration Support**: Add a migration mechanism to update pool ID without breaking existing functionality.

5. **Documentation**: Clearly document the pool program ID and update process.

6. **Validation**: When updating pool ID, validate it's a valid program account.

