# Manual Byte-Level Account Reads

## Severity: HIGH

## Description

Multiple contracts perform manual byte-level reads of account data instead of using Anchor's type-safe account loading. This pattern creates vulnerabilities where account data corruption, type confusion, or buffer overflows can lead to security issues or incorrect behavior.

## Affected Contracts

1. **ptf_pool**: Extensive manual byte reads in `initialize_pool`, `shield`, `ensure_mint_active`
2. **ptf_verifier_groth16**: Account data integrity validation issues
3. **ptf_factory**: Some manual reads for mint mapping data

## Vulnerability Pattern

### Current Anti-Pattern

```rust
// ptf_pool/src/lib.rs - initialize_pool
let vault_data = ctx.accounts.vault_state.try_borrow_data()?;
if vault_data.len() < 8 + 32 {
    return err!(PoolError::MintMappingCorrupt);
}
let vault_origin_bytes: [u8; 32] = vault_data[8..40]
    .try_into()
    .map_err(|_| PoolError::MintMappingCorrupt)?;
let vault_origin = Pubkey::new_from_array(vault_origin_bytes);
drop(vault_data);

// Read pool_authority from vault_state (offset 8 + 32 = 40)
let vault_data2 = ctx.accounts.vault_state.try_borrow_data()?;
if vault_data2.len() < 8 + 64 {
    return err!(PoolError::MintMappingCorrupt);
}
let pool_authority_bytes: [u8; 32] = vault_data2[40..72]
    .try_into()
    .map_err(|_| PoolError::MintMappingCorrupt)?;
let vault_pool_authority = Pubkey::new_from_array(pool_authority_bytes);
```

### Why This Is Dangerous

1. **No Type Safety**: Manual reads don't guarantee data structure matches expectations
2. **Buffer Overflow Risk**: Bounds checking might be insufficient or missing
3. **Type Confusion**: Data might be interpreted as wrong type
4. **Data Corruption**: Corrupted data might be read without detection
5. **Race Conditions**: Reading while data is being modified can cause inconsistencies
6. **Maintenance Burden**: Manual offset calculations are error-prone

## Specific Instances

### ptf_pool - Vault State Reads

**Location**: `initialize_pool` instruction (lines 64-80)
**Issue**: Reads `vault_state.origin_mint` and `pool_authority` directly from bytes
**Impact**: If account structure changes or data is corrupted, reads could fail or produce wrong values
**Reference**: `Audit/ptf_pool/account-data-corruption.md`

### ptf_pool - Verifying Key Reads

**Location**: `shield` instruction (lines 723-730)
**Issue**: Reads verifying key data directly from bytes
**Impact**: Invalid key data could bypass validation
**Reference**: `Audit/ptf_pool/account-data-corruption.md`

### ptf_pool - Mint Mapping Reads

**Location**: `ensure_mint_active` function (lines 4278-4290)
**Issue**: Reads mint mapping status directly from bytes
**Impact**: Corrupted status could allow frozen mints to be used
**Reference**: `Audit/ptf_pool/account-data-corruption.md`

### ptf_verifier_groth16 - Account Data Integrity

**Location**: `verify_account_hash` function
**Issue**: Only validates hash, not full account structure
**Impact**: Corrupted fields might not be detected
**Reference**: `Audit/ptf_verifier_groth16/account-data-integrity-validation.md`

## Exploitation Scenarios

### Scenario 1: Buffer Overflow

```rust
// 1. Account data is shorter than expected
// 2. Code reads beyond account bounds
// 3. Panic or reads invalid memory
// 4. Transaction fails or produces incorrect results
// 5. System becomes unstable
```

### Scenario 2: Data Corruption

```rust
// 1. Account data becomes corrupted (bug or attack)
// 2. Code reads corrupted data
// 3. Incorrect values are used in calculations
// 4. Security checks might be bypassed
// 5. Invalid operations are allowed
```

### Scenario 3: Type Confusion

```rust
// 1. Account has wrong structure but correct owner
// 2. Code reads bytes expecting one structure
// 3. Bytes are interpreted as different type
// 4. Incorrect values used in operations
// 5. Security is compromised
```

### Scenario 4: Structure Changes

```rust
// 1. Account structure is updated in new version
// 2. Old code still uses manual byte reads with old offsets
// 3. Reads wrong fields or fails bounds checks
// 4. System breaks after upgrade
// 5. Funds could be lost
```

## Root Cause Analysis

### Design Decisions

1. **Performance**: Manual reads avoid Anchor's deserialization overhead
2. **Flexibility**: Allows reading from accounts owned by other programs
3. **Control**: Developers want precise control over data access
4. **Stack Usage**: Manual reads use less stack than full deserialization

### Why This Fails

1. **Error-Prone**: Manual offset calculations are easy to get wrong
2. **Maintenance**: Structure changes break manual reads
3. **Security**: No type safety or structure validation
4. **Debugging**: Harder to debug when reads fail
5. **Testing**: Harder to test all edge cases

## Mitigation Strategy

### 1. Use Anchor Types Where Possible

```rust
// Instead of:
let vault_data = ctx.accounts.vault_state.try_borrow_data()?;
let origin_bytes: [u8; 32] = vault_data[8..40].try_into()?;
let origin = Pubkey::new_from_array(origin_bytes);

// Use:
#[account]
pub vault_state: Account<'info, ptf_vault::VaultState>,

// Then access:
let origin = ctx.accounts.vault_state.origin_mint;
let authority = ctx.accounts.vault_state.pool_authority;
```

### 2. Create Safe Read Helpers

```rust
// Safe account data reading helper
fn read_account_field<T>(
    account: &AccountInfo,
    offset: usize,
    expected_size: usize,
) -> Result<T> 
where
    T: Copy,
{
    // Validate account is owned by expected program
    // (program-specific validation)
    
    // Validate account data length
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= 8 + offset + expected_size, // 8 for discriminator
        PoolError::AccountDataTooShort
    );
    
    // Validate discriminator
    let discriminator = &data[0..8];
    require!(
        discriminator == &T::DISCRIMINATOR, // If T has discriminator
        PoolError::InvalidAccountDiscriminator
    );
    
    // Read field with bounds check
    let field_bytes = &data[8 + offset..8 + offset + expected_size];
    // Convert to T safely
    // ...
}

// Enhanced vault state reading
fn read_vault_state_safely(
    vault_state: &AccountInfo,
) -> Result<(Pubkey, Pubkey)> {
    // Validate owner
    require_keys_eq!(
        *vault_state.owner,
        ptf_vault::ID,
        PoolError::InvalidAccountOwner
    );
    
    // Validate data length
    let data = vault_state.try_borrow_data()?;
    require!(
        data.len() >= 8 + 64, // discriminator + origin_mint + pool_authority
        PoolError::AccountDataTooShort
    );
    
    // Validate discriminator (if known)
    // ...
    
    // Read fields with validation
    let origin_bytes: [u8; 32] = data[8..40]
        .try_into()
        .map_err(|_| PoolError::AccountDataCorrupt)?;
    let authority_bytes: [u8; 32] = data[40..72]
        .try_into()
        .map_err(|_| PoolError::AccountDataCorrupt)?;
    
    // Validate pubkeys are not default
    let origin = Pubkey::new_from_array(origin_bytes);
    let authority = Pubkey::new_from_array(authority_bytes);
    require!(
        origin != Pubkey::default(),
        PoolError::InvalidAccountData
    );
    require!(
        authority != Pubkey::default(),
        PoolError::InvalidAccountData
    );
    
    Ok((origin, authority))
}
```

### 3. Use ZeroCopy for Cross-Program Accounts

```rust
// For accounts owned by other programs, use ZeroCopy
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct VaultStateRaw {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    // ... other fields ...
}

// Then use bytemuck or direct pointer access
unsafe {
    let ptr = data.as_ptr().add(8) as *const VaultStateRaw;
    let vault_state = &*ptr;
    // Access fields safely
}
```

### 4. Add Comprehensive Validation

```rust
fn validate_account_structure(
    account: &AccountInfo,
    expected_owner: Pubkey,
    expected_discriminator: Option<[u8; 8]>,
    min_size: usize,
) -> Result<()> {
    // Validate owner
    require_keys_eq!(
        *account.owner,
        expected_owner,
        PoolError::InvalidAccountOwner
    );
    
    // Validate data length
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= min_size,
        PoolError::AccountDataTooShort
    );
    
    // Validate discriminator if provided
    if let Some(discriminator) = expected_discriminator {
        require!(
            data[0..8] == discriminator,
            PoolError::InvalidAccountDiscriminator
        );
    }
    
    Ok(())
}
```

### 5. Add Checksums/Hashes

```rust
// Add checksum to account data
#[account]
pub struct VaultState {
    pub origin_mint: Pubkey,
    pub pool_authority: Pubkey,
    pub checksum: [u8; 32],  // Hash of other fields
}

// Validate checksum on read
fn validate_vault_state_checksum(
    state: &VaultState,
) -> Result<()> {
    let mut hasher = Keccak256::new();
    hasher.update(&state.origin_mint.to_bytes());
    hasher.update(&state.pool_authority.to_bytes());
    let computed: [u8; 32] = hasher.finalize().into();
    
    require!(
        computed == state.checksum,
        PoolError::AccountDataCorrupt
    );
    
    Ok(())
}
```

## Implementation Plan

### Phase 1: Audit All Manual Reads

1. List all manual byte reads across all contracts
2. Identify which can be replaced with Anchor types
3. Categorize by risk level

### Phase 2: Create Safe Helpers

1. Create shared validation helpers
2. Add comprehensive error types
3. Write tests for helpers

### Phase 3: Replace Manual Reads

1. Replace with Anchor types where possible
2. Use safe helpers for remaining cases
3. Add validation and error handling

### Phase 4: Testing and Verification

1. Test with corrupted data
2. Test with wrong account types
3. Test with structure changes
4. Verify no regressions

## Recommended Code Standards

1. **Prefer Anchor Types**: Always use Anchor's typed accounts when possible
2. **Safe Helpers**: If manual reads are required, use safe helper functions
3. **Comprehensive Validation**: Always validate account structure before reading
4. **Bounds Checking**: Always check bounds before reading
5. **Error Handling**: Provide clear error messages for validation failures

## Impact Assessment

- **Security**: HIGH - Manual reads create multiple attack vectors
- **Maintainability**: HIGH - Manual reads are error-prone and hard to maintain
- **Performance**: LOW - Anchor types have minimal overhead
- **Compatibility**: MEDIUM - Changes might require account structure updates

## Conclusion

Manual byte-level account reads are a dangerous pattern that creates multiple security vulnerabilities. This pattern should be systematically replaced with Anchor's type-safe account loading or safe helper functions with comprehensive validation. The fix requires careful refactoring but is essential for security and maintainability.

