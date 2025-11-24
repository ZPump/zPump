# Load Mint State Error Handling

## Severity: MEDIUM

## Description

The `load_mint_state` function uses generic error mapping which loses error context. Additionally, the deserialization might partially succeed, leaving the cursor in an inconsistent state.

## Vulnerability Details

### Current Implementation

```1491:1503:programs/factory/src/lib.rs
fn load_mint_state(account_info: &AccountInfo<'_>) -> Result<Mint> {
    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(FactoryError::AccountDataReadFailed))?;
    // Minimum mint account size is 82 bytes
    require!(
        data.len() >= 82,
        FactoryError::AccountDataTooShort
    );
    let mut slice: &[u8] = &data;
    Mint::try_deserialize(&mut slice)
        .map_err(|_| error!(FactoryError::InvalidMintFormat))
}
```

### Potential Vulnerabilities

1. **Generic Error**: The error mapping loses the original deserialization error, making debugging difficult.

2. **No Cursor Validation**: After deserialization, the code doesn't validate that all bytes were consumed, which could indicate partial deserialization.

3. **Account Type Validation**: The code doesn't explicitly validate that the account is a mint account before deserialization.

4. **Error Message**: "InvalidMintFormat" is generic and doesn't indicate what went wrong.

## Exploitation Scenario

```rust
// Scenario: Partial deserialization
// 1. Mint account is corrupted or has unexpected format
// 2. Deserialization partially succeeds
// 3. Some fields are correct, others are wrong
// 4. Validation might pass with incorrect data
// 5. Operations proceed with bad data
```

## Code References

- `load_mint_state`: Lines 1491-1503
- Called from: `load_mint_decimals`, `prepare_ptkn_mint`

## Mitigation

1. **Preserve error context**:
```rust
fn load_mint_state(account_info: &AccountInfo<'_>) -> Result<Mint> {
    let data = account_info
        .try_borrow_data()
        .map_err(|e| {
            msg!("Failed to borrow mint account data: {:?}", e);
            error!(FactoryError::AccountDataReadFailed)
        })?;
    
    require!(
        data.len() >= 82,
        FactoryError::AccountDataTooShort
    );
    
    let mut slice: &[u8] = &data;
    let mint = Mint::try_deserialize(&mut slice)
        .map_err(|e| {
            msg!("Failed to deserialize mint: {:?}, data len: {}", e, data.len());
            error!(FactoryError::InvalidMintFormat)
        })?;
    
    // CRITICAL FIX: Validate all bytes were consumed
    require!(
        slice.is_empty(),
        FactoryError::InvalidMintFormat
    );
    
    Ok(mint)
}
```

2. **Validate account type**:
```rust
// Validate account is owned by token program
require_keys_eq!(
    *account_info.owner,
    SPL_TOKEN_PROGRAM_ID || SPL_TOKEN_2022_PROGRAM_ID,
    FactoryError::InvalidMintFormat
);
```

3. **Add comprehensive validation**:
```rust
// After deserialization, validate mint fields are reasonable
require!(
    mint.decimals <= 18,
    FactoryError::InvalidMintFormat
);
```

## Additional Considerations

- Generic error handling makes debugging difficult
- Consider preserving original error information
- Add validation for deserialized data
- Document expected mint account format

