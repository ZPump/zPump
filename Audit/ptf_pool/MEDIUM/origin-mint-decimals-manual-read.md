# Origin Mint Decimals Manual Read

## Severity: MEDIUM

## Description

The code manually reads decimals from mint account data at offset 44, but this assumes a specific account layout. If the mint account structure changes or is different for Token vs Token-2022, the read could be incorrect.

## Vulnerability Details

### Current Implementation

```321:327:programs/pool/src/lib.rs
// Read origin_mint decimals
let origin_data = ctx.accounts.origin_mint.try_borrow_data()?;
if origin_data.len() < 44 {
    return err!(PoolError::TwinMintDecimalsMismatch);
}
let origin_decimals = origin_data[44];
drop(origin_data);
```

### Potential Vulnerabilities

1. **Layout Assumption**: The code assumes decimals are at offset 44, but this might differ between Token and Token-2022 programs, or if the account structure changes.

2. **No Type Validation**: The code doesn't validate that the account is actually a mint account before reading.

3. **Hardcoded Offset**: Using a hardcoded offset is fragile and could break if the account layout changes.

4. **Error Message Mismatch**: The error is `TwinMintDecimalsMismatch` but this is reading origin_mint, not twin_mint.

## Exploitation Scenario

```rust
// Scenario: Account layout change
// 1. Token-2022 mint account layout differs from Token
// 2. Decimals are at different offset
// 3. Code reads wrong byte
// 4. Gets incorrect decimals value
// 5. Validation fails or passes incorrectly
```

## Code References

- Origin mint decimals read: Lines 321-327
- Similar pattern for twin mint: Line 312

## Mitigation

1. **Use Anchor's InterfaceAccount**:
```rust
// CRITICAL FIX: Use Anchor's InterfaceAccount to read decimals safely
// InterfaceAccount already validates account type and provides safe access
let origin_decimals = ctx.accounts.origin_mint.decimals;
```

2. **Validate account type**:
```rust
// If manual read is necessary, validate account type first
require_keys_eq!(
    *ctx.accounts.origin_mint.owner,
    SPL_TOKEN_PROGRAM_ID || SPL_TOKEN_2022_PROGRAM_ID,
    PoolError::InvalidMint
);
```

3. **Use proper deserialization**:
```rust
// Deserialize mint account properly instead of manual byte read
let mint_state = Mint::try_deserialize(&mut &origin_data[..])?;
let origin_decimals = mint_state.decimals;
```

4. **Fix error message**:
```rust
// Use appropriate error message
if origin_data.len() < 44 {
    return err!(PoolError::AccountDataTooShort);
}
```

## Additional Considerations

- Manual byte reads are fragile
- Use Anchor types when possible
- Validate account types before reading
- Consider whether Token and Token-2022 have different layouts

