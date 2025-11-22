# Register Mint Allows Updates Without Proper Validation

## Severity: MEDIUM

## Description

The `register_mint` function allows updating existing mint mappings without proper validation. If a mint mapping already exists, the function updates mutable fields (status, decimals, features, fee_bps_override) without checking if the update is authorized or if it conflicts with existing state. This could allow unauthorized modifications or state corruption.

## Vulnerability Details

### Current Implementation

```rust
if mapping.origin_mint == Pubkey::default() {
    // Initialize new mapping
} else {
    // Account already initialized - just update mutable fields
    require_keys_eq!(
        mapping.origin_mint,
        ctx.accounts.origin_mint.key(),
        FactoryError::OriginMintMismatch
    );
    mapping.status = MintStatus::Active as u8;
    mapping.decimals = decimals;  // Can change decimals!
    mapping.features = FeatureFlags::from(...);
    mapping.has_fee_override = fee_bps_override.is_some();
    mapping.fee_bps_override = fee_bps_override.unwrap_or_default();
}
```

The update path:
- Only checks `origin_mint` matches
- Updates `decimals` without validation
- Updates `status` to Active (could unfreeze frozen mints)
- Updates `features` and `fee_bps_override`
- Does NOT check if update is appropriate
- Does NOT validate decimals match actual mint

### Potential Vulnerabilities

1. **Unauthorized Status Changes**: A frozen mint could be unfrozen by re-registering it, bypassing the freeze mechanism.

2. **Decimals Mismatch**: Decimals can be changed without validating they match the actual mint, leading to incorrect calculations.

3. **Feature Flag Changes**: Feature flags can be changed without going through proper update mechanisms.

4. **Fee Override Changes**: Fee overrides can be changed without authorization checks.

5. **State Corruption**: If the mapping is in an unexpected state, re-registration could corrupt it.

## Exploitation Scenario

```rust
// Scenario 1: Unfreeze frozen mint
// 1. Mint is frozen by governance
// 2. Attacker re-registers mint with same origin_mint
// 3. Status is set to Active
// 4. Frozen mint is now active
// 5. Freeze mechanism is bypassed

// Scenario 2: Decimals manipulation
// 1. Mint is registered with decimals=9
// 2. Attacker re-registers with decimals=6
// 3. System uses wrong decimals
// 4. Amount calculations are incorrect
// 5. Users receive wrong amounts

// Scenario 3: Feature flag bypass
// 1. Mint has certain features disabled
// 2. Attacker re-registers with different features
// 3. Features are changed without proper authorization
// 4. Security controls are bypassed
```

## Code References

- Update path: Lines 113-126
- Status update: Line 120
- Decimals update: Line 121
- Features update: Lines 122-123
- Fee override update: Lines 124-125

## Mitigation

1. **Prevent Updates in register_mint**: Only allow initialization, require updates to go through `update_mint`:

```rust
pub fn register_mint(
    ctx: Context<RegisterMint>,
    // ... params ...
) -> Result<()> {
    // ... existing checks ...
    
    let mapping = &mut ctx.accounts.mint_mapping;
    
    // Only allow initialization, not updates
    require!(
        mapping.origin_mint == Pubkey::default(),
        FactoryError::MintAlreadyRegistered
    );
    
    // Initialize new mapping
    mapping.origin_mint = ctx.accounts.origin_mint.key();
    // ... rest of initialization ...
}
```

2. **Validate Updates Properly**: If updates are allowed, add proper validation:

```rust
} else {
    // Account already initialized - validate update is appropriate
    require_keys_eq!(
        mapping.origin_mint,
        ctx.accounts.origin_mint.key(),
        FactoryError::OriginMintMismatch
    );
    
    // Don't allow changing decimals if mint is already registered
    require!(
        mapping.decimals == decimals,
        FactoryError::DecimalsCannotChange
    );
    
    // Don't allow unfreezing frozen mints
    if mapping.status == MintStatus::Frozen as u8 {
        require!(
            status == MintStatus::Frozen as u8,
            FactoryError::CannotUnfreezeViaRegistration
        );
    }
    
    // Only update features and fee if explicitly allowed
    // Or require update_mint for changes
}
```

3. **Require Update Path**: Force all changes to go through `update_mint` which has proper authorization:

```rust
// In register_mint, if mapping exists, reject
require!(
    mapping.origin_mint == Pubkey::default(),
    FactoryError::UseUpdateMintForChanges
);
```

4. **Add Error Types**: Add error variants for update restrictions:

```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("mint is already registered, use update_mint for changes")]
    MintAlreadyRegistered,
    #[msg("decimals cannot be changed after registration")]
    DecimalsCannotChange,
    #[msg("cannot unfreeze mint via registration")]
    CannotUnfreezeViaRegistration,
    #[msg("use update_mint instruction for changes")]
    UseUpdateMintForChanges,
}
```

5. **Document Behavior**: Clearly document that `register_mint` is for initial registration only, and `update_mint` should be used for changes.

6. **Add Validation**: If updates must be allowed, add comprehensive validation of all changes.

