# Mint Registration Security

## Severity: MEDIUM

## Description

The factory program allows registration of new mints and their association with pools. If mint registration is not properly secured, malicious mints could be registered, or existing mints could be manipulated.

## Vulnerability Details

### Current Implementation

Mint registration includes:
- `register_mint`: Registers a new mint with optional ptkn mint
- Validation of mint mapping PDA
- Status tracking (Active/Frozen)
- Feature flags and fee overrides

### Potential Vulnerabilities

1. **Unauthorized Mint Registration**: If authority checks are bypassed, unauthorized mints could be registered.

2. **Mint Mapping Corruption**: If the mint mapping account structure is corrupted or manipulated, pool associations could be incorrect.

3. **Duplicate Mint Registration**: If the same mint can be registered multiple times, it could cause confusion or allow manipulation.

4. **PTKN Mint Authority**: When creating or reusing PTKN mints, authority management is critical. If freeze authority is not properly set, accounts could be frozen.

5. **Status Manipulation**: If mint status (Active/Frozen) can be manipulated, operations could be incorrectly allowed or blocked.

6. **Fee Override Abuse**: Fee overrides could be set to extreme values, potentially causing issues in pool operations.

## Exploitation Scenario

```rust
// Scenario 1: Unauthorized registration
// 1. Attacker finds way to bypass authority check
// 2. Attacker registers malicious mint
// 3. Attacker associates it with legitimate pool
// 4. Attacker can manipulate pool operations

// Scenario 2: Mint mapping corruption
// 1. Attacker corrupts mint mapping account data
// 2. Mapping points to wrong pool or has incorrect status
// 3. Operations use wrong pool or incorrect status
// 4. Funds could be lost or operations blocked incorrectly

// Scenario 3: PTKN mint authority
// 1. Attacker registers mint with PTKN that has freeze authority set to attacker
// 2. Attacker freezes all PTKN accounts
// 3. Users cannot unshield to PTKN
// 4. DoS attack on PTKN functionality
```

## Code References

- Mint registration: `register_mint` (lines 80-152)
- PTKN mint preparation: `prepare_ptkn_mint` (lines 964-1043)
- Mint status: `freeze_mapping`, `thaw_mapping` (lines 189-207)
- Mint update: `update_mint` (lines 154-187)

## Mitigation

1. **Strict Authority Validation**: Ensure authority checks cannot be bypassed. Use Anchor's `has_one` constraint and additional programmatic checks.

2. **Mint Mapping Integrity**: Add checksums or hashes to mint mapping to detect corruption. Validate mapping structure before use.

3. **Duplicate Prevention**: Ensure each mint can only be registered once. Check if mapping already exists and is properly initialized.

4. **PTKN Authority Management**: 
   - Always set freeze authority to None or factory PDA
   - Validate freeze authority before registration
   - Reject mints with unauthorized freeze authority

5. **Status Validation**: Ensure status changes (freeze/thaw) can only be performed by authorized parties and go through proper checks.

6. **Fee Override Limits**: Implement maximum and minimum limits for fee overrides to prevent abuse.

7. **Registration Events**: Emit detailed events for all registration operations to enable monitoring and audit trails.

8. **Mint Verification**: Verify that the mint account is a valid SPL token mint before registration.

## Recommended Code Changes

```rust
// Enhanced mint registration validation
pub fn register_mint(
    ctx: Context<RegisterMint>,
    // ... args ...
) -> Result<()> {
    // Verify mint is valid SPL token mint
    let mint_data = ctx.accounts.origin_mint.try_borrow_data()?;
    require!(
        mint_data.len() >= spl_token::state::Mint::LEN,
        FactoryError::InvalidMint
    );
    
    // Check for duplicate registration
    if mapping.origin_mint != Pubkey::default() {
        require!(
            mapping.origin_mint == ctx.accounts.origin_mint.key(),
            FactoryError::MintAlreadyRegistered
        );
    }
    
    // Validate fee override limits
    if let Some(fee) = fee_bps_override {
        const MIN_FEE_BPS: u16 = 0;
        const MAX_FEE_BPS: u16 = 1000; // 10% max
        require!(
            fee >= MIN_FEE_BPS && fee <= MAX_FEE_BPS,
            FactoryError::FeeOverrideOutOfRange
        );
    }
    
    // ... existing code ...
}

// Enhanced PTKN authority validation
fn prepare_ptkn_mint<'info>(
    // ... args ...
) -> Result<Pubkey> {
    // ... existing code ...
    
    // Strict freeze authority validation
    if let COption::Some(freeze_auth) = mint_account.freeze_authority {
        // Only allow None or factory PDA as freeze authority
        require!(
            freeze_auth == factory_state.key() || freeze_auth == Pubkey::default(),
            FactoryError::UnauthorizedFreezeAuthority
        );
    }
    
    // For new mints, always set freeze authority to None
    if mint_info.owner == &system_program::ID && mint_info.data_is_empty() {
        // ... create mint ...
        // Initialize with freeze authority = None
        token_interface::initialize_mint2(init_ctx, decimals, &factory_state.key(), None)?;
    }
    
    Ok(*mint_info.key)
}

// Mint mapping integrity check
fn validate_mint_mapping(mapping: &MintMapping) -> Result<()> {
    // Verify mapping is properly initialized
    require!(
        mapping.origin_mint != Pubkey::default(),
        FactoryError::MintMappingUninitialized
    );
    
    // Verify status is valid
    require!(
        mapping.status == MintStatus::Active as u8 || 
        mapping.status == MintStatus::Frozen as u8,
        FactoryError::InvalidMintStatus
    );
    
    Ok(())
}
```

