# Factory Prepare PTKN Freeze Authority Validation Gap

## Severity: MEDIUM

## Description

In `prepare_ptkn_mint`, the freeze authority validation checks if it's the factory or None, but if it's neither, the function returns an error. However, there's no explicit check that the freeze authority is actually set to None after validation, potentially leaving it in an incorrect state.

## Vulnerability Details

### Current Implementation

```1471:1486:programs/factory/src/lib.rs
// CRITICAL FIX: Also set freeze authority to None or factory PDA
// This prevents attackers from freezing accounts after registration
// Check if freeze authority exists and is not already None
if let COption::Some(freeze_auth) = mint_account.freeze_authority {
    // If freeze authority is not None and not the factory, we need to set it
    // However, we can only set it if we have the current freeze authority signer
    // For now, we require that reused mints have freeze authority as None or factory
    // If it's not, we reject the mint (safer approach)
    if freeze_auth != factory_state.key() {
        // Reject mints with non-factory freeze authority
        // The caller must first set freeze authority to None or factory before registration
        return err!(FactoryError::Unauthorized);
    }
}
// If freeze authority is None, that's fine - we don't need to do anything
```

### Potential Vulnerabilities

1. **Freeze Authority Not Set**: If freeze authority is the factory, the code accepts it but doesn't explicitly set it to None. The comment says "set freeze authority to None", but the code doesn't actually do it.

2. **Inconsistent State**: If freeze authority is factory, it's accepted, but the intended behavior (setting to None) isn't implemented.

3. **Missing CPI**: The code should call `set_authority` to set freeze authority to None, but it doesn't.

## Exploitation Scenario

```rust
// Scenario: Freeze authority not cleared
// 1. Mint has freeze authority = factory
// 2. Code accepts it (freeze_auth == factory_state.key())
// 3. But doesn't set it to None
// 4. Freeze authority remains as factory
// 5. Factory could freeze accounts (might be intended, but comment says otherwise)
```

## Code References

- Freeze authority validation: Lines 1471-1486
- Comment says "set freeze authority to None" but code doesn't do it

## Mitigation

1. **Actually set freeze authority to None**:
```rust
// CRITICAL FIX: Set freeze authority to None for new PTKN mints
// This prevents anyone from freezing accounts
if let COption::Some(freeze_auth) = mint_account.freeze_authority {
    if freeze_auth != factory_state.key() {
        // Reject mints with non-factory freeze authority
        return err!(FactoryError::Unauthorized);
    }
    // If it's factory, set it to None
    // We need the current freeze authority signer (factory PDA)
    let cpi_accounts = SetAuthority {
        account_or_mint: mint_info.clone(),
        current_authority: factory_state_account.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        token_program.to_account_info(),
        cpi_accounts,
        &[&factory_seeds],
    );
    token_interface::set_authority(
        cpi_ctx,
        AuthorityType::FreezeAccount,
        None, // Set to None
    )?;
}
```

2. **Or document that factory freeze authority is acceptable**:
```rust
// If factory freeze authority is acceptable, document it
// Otherwise, implement the set_authority call
```

3. **Clarify requirements**:
```rust
// Document whether freeze authority should be:
// - None (no one can freeze)
// - Factory (factory can freeze)
// - Something else
```

## Additional Considerations

- The comment says "set freeze authority to None" but code doesn't do it
- Either implement the set or update the comment
- Consider security implications of factory having freeze authority
- Document the intended behavior clearly

