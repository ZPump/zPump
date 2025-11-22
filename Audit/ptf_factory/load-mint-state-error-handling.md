# Confusing Error Handling in load_mint_state

## Severity: MEDIUM

## Description

The `load_mint_state` and `load_mint_decimals` functions use `FactoryError::InvalidDecimals` for all deserialization and data access failures, even when the actual issue is not related to decimals. This makes debugging difficult and could mask real issues like account corruption, wrong account type, or deserialization failures.

## Vulnerability Details

### Current Implementation

```rust
fn load_mint_state(account_info: &AccountInfo<'_>) -> Result<Mint> {
    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(FactoryError::InvalidDecimals))?;
    let mut slice: &[u8] = &data;
    Mint::try_deserialize(&mut slice).map_err(|_| error!(FactoryError::InvalidDecimals))
}

fn load_mint_decimals(account_info: &AccountInfo<'_>) -> Result<u8> {
    Ok(load_mint_state(account_info)?.decimals)
}
```

Both functions:
- Use `InvalidDecimals` for borrow failures
- Use `InvalidDecimals` for deserialization failures
- Use `InvalidDecimals` for wrong account type
- Use `InvalidDecimals` for account corruption

### Potential Vulnerabilities

1. **Debugging Difficulty**: When errors occur, it's unclear if the issue is actually decimals, account type, corruption, or something else.

2. **Masked Errors**: Real issues (e.g., account corruption, wrong account type) are reported as "invalid decimals", making them harder to identify and fix.

3. **Error Confusion**: Users and developers might misinterpret errors, leading to incorrect fixes or workarounds.

4. **Security Issues**: If account data is corrupted or tampered with, the error message doesn't indicate this, potentially hiding security issues.

## Exploitation Scenario

```rust
// Scenario 1: Account corruption
// 1. Account data is corrupted
// 2. Deserialization fails
// 3. Error says "InvalidDecimals"
// 4. Developer tries to fix decimals
// 5. Real issue (corruption) is not addressed
// 6. Security issue goes undetected

// Scenario 2: Wrong account type
// 1. Token account is passed instead of mint
// 2. Deserialization fails
// 3. Error says "InvalidDecimals"
// 4. Developer is confused
// 5. Issue is not properly identified

// Scenario 3: Deserialization failure
// 1. Account data format is wrong
// 2. Deserialization fails
// 3. Error says "InvalidDecimals"
// 4. Real issue is not clear
// 5. Debugging is difficult
```

## Code References

- `load_mint_state`: Lines 1045-1051
- `load_mint_decimals`: Lines 1053-1055
- Error usage: `FactoryError::InvalidDecimals` for all failures

## Mitigation

1. **Use Specific Error Types**: Create specific error types for different failure modes:

```rust
fn load_mint_state(account_info: &AccountInfo<'_>) -> Result<Mint> {
    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(FactoryError::AccountDataBorrowFailed))?;
    
    // Check minimum size
    if data.len() < 82 {
        return Err(error!(FactoryError::InvalidMintAccountSize));
    }
    
    let mut slice: &[u8] = &data;
    Mint::try_deserialize(&mut slice)
        .map_err(|_| error!(FactoryError::MintDeserializationFailed))
}

fn load_mint_decimals(account_info: &AccountInfo<'_>) -> Result<u8> {
    let mint = load_mint_state(account_info)?;
    Ok(mint.decimals)
}
```

2. **Add Error Types**: Add new error variants:

```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("failed to borrow account data")]
    AccountDataBorrowFailed,
    #[msg("mint account size is invalid")]
    InvalidMintAccountSize,
    #[msg("failed to deserialize mint account")]
    MintDeserializationFailed,
    #[msg("account is not a valid mint account")]
    InvalidMintAccount,
}
```

3. **Validate Account Type First**: Before deserialization, validate the account is a mint:

```rust
fn load_mint_state(account_info: &AccountInfo<'_>) -> Result<Mint> {
    // Validate account is owned by token program
    let token_program_ids = [
        anchor_spl::token::ID,
        anchor_spl::token_2022::ID,
    ];
    
    require!(
        token_program_ids.contains(account_info.owner),
        FactoryError::InvalidMintAccount
    );
    
    // Validate minimum size
    require!(
        account_info.data_len() >= 82,
        FactoryError::InvalidMintAccountSize
    );
    
    // Then deserialize
    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(FactoryError::AccountDataBorrowFailed))?;
    
    let mut slice: &[u8] = &data;
    Mint::try_deserialize(&mut slice)
        .map_err(|_| error!(FactoryError::MintDeserializationFailed))
}
```

4. **Better Error Messages**: Provide more context in error messages to help debugging.

5. **Logging**: Consider adding debug logging (in non-production builds) to help identify issues.

6. **Documentation**: Document what each error means and when it occurs.

