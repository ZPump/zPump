# Hardcoded Factory Program ID

## Severity: HIGH

## Description

The verifier program hardcodes the factory program ID as a constant. If the factory program is upgraded, redeployed with a new program ID, or if there's a need to support multiple factory instances, the verifier will be unable to work with the new factory, breaking the entire system.

## Vulnerability Details

### Current Implementation

```rust
const PTF_FACTORY_PROGRAM_ID: Pubkey = pubkey!("4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy");
```

This constant is used to:
- Validate authority ownership (line 79)
- Derive expected factory PDA (line 86)

### Potential Vulnerabilities

1. **Factory Upgrade Incompatibility**: If the factory program is upgraded and gets a new program ID, the verifier will reject all key registrations, breaking the system.

2. **Multi-Factory Support**: If the system needs to support multiple factory instances (e.g., for different networks or test environments), the hardcoded ID prevents this.

3. **Deployment Flexibility**: Hardcoded IDs reduce deployment flexibility and make it harder to test or deploy to different environments.

4. **Program Migration**: If the factory needs to be migrated to a new program ID (e.g., due to security issues), the verifier cannot be easily updated.

5. **Testing Limitations**: Hardcoded IDs make it difficult to test with mock factories or different factory implementations.

## Exploitation Scenario

```rust
// Scenario 1: Factory upgrade breaks verifier
// 1. Factory program is upgraded to new version
// 2. New factory gets new program ID
// 3. Verifier still expects old program ID
// 4. All key registrations fail
// 5. System becomes unusable

// Scenario 2: Multi-environment deployment
// 1. System needs to support testnet and mainnet factories
// 2. Factories have different program IDs
// 3. Verifier can only work with one
// 4. System cannot support multiple environments

// Scenario 3: Factory compromise
// 1. Factory program is compromised
// 2. New secure factory is deployed with new ID
// 3. Verifier cannot work with new factory
// 4. System remains broken until verifier is upgraded
```

## Code References

- Hardcoded factory ID: Line 8
- Authority validation: Lines 77-81
- Factory PDA derivation: Lines 84-87

## Mitigation

1. **Store Factory ID in Verifier Config**: Create a verifier configuration account that stores the factory program ID:

```rust
#[account]
pub struct VerifierConfig {
    pub factory_program_id: Pubkey,
    pub authority: Pubkey, // For updating config
}

pub fn initialize_verifier_config(
    ctx: Context<InitializeVerifierConfig>,
    factory_program_id: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.factory_program_id = factory_program_id;
    config.authority = ctx.accounts.authority.key();
    Ok(())
}

pub fn update_factory_program_id(
    ctx: Context<UpdateFactoryProgramId>,
    new_factory_program_id: Pubkey,
) -> Result<()> {
    // Require config authority
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.config.authority,
        VerifierError::Unauthorized
    );
    
    ctx.accounts.config.factory_program_id = new_factory_program_id;
    Ok(())
}
```

2. **Use Config in Validation**: Read factory ID from config instead of constant:

```rust
pub fn initialize_verifying_key(
    ctx: Context<InitializeVerifyingKey>,
    // ... params ...
) -> Result<()> {
    let config = &ctx.accounts.verifier_config;
    
    // Verify authority is owned by factory program
    require_keys_eq!(
        *ctx.accounts.authority.owner,
        config.factory_program_id,
        VerifierError::UnauthorizedAuthority
    );
    
    // Derive factory PDA using config
    let (expected_factory_state, _) = Pubkey::find_program_address(
        &[b"factory", config.factory_program_id.as_ref()],
        &config.factory_program_id,
    );
    
    // ... rest of validation ...
}
```

3. **Migration Support**: Add a migration mechanism to update factory ID without breaking existing keys.

4. **Multi-Factory Support**: If needed, support multiple factory program IDs or use a factory registry.

5. **Documentation**: Clearly document the factory program ID and update process.

6. **Versioning**: Consider versioning the verifier config to support future changes.

