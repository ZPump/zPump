# Twin Mint Authority Security

## Severity: MEDIUM

## Description

The pool program supports optional twin mints (PTKN) for privacy tokens. Twin mint authority management is critical - if authority is compromised or misconfigured, tokens could be minted incorrectly or accounts could be frozen.

## Vulnerability Details

### Current Implementation

Twin mint handling includes:
- Authority validation in `initialize_pool` (lines 181-209)
- Mint authority must be factory PDA or pool PDA
- Freeze authority validation in factory (lines 1025-1038)

### Potential Vulnerabilities

1. **Authority Mismatch**: If twin mint authority doesn't match expected value, operations could fail or behave incorrectly.

2. **Freeze Authority**: If freeze authority is set incorrectly, accounts could be frozen, causing DoS.

3. **Mint Authority Compromise**: If mint authority is compromised, unlimited tokens could be minted.

4. **Authority Change**: If authority can be changed without proper safeguards, security could be compromised.

5. **Decimals Mismatch**: If twin mint decimals don't match origin mint, calculations could be incorrect.

6. **Mint Validation**: Twin mint validation might not catch all edge cases.

## Exploitation Scenario

```rust
// Scenario 1: Freeze authority attack
// 1. Twin mint is registered with freeze authority set to attacker
// 2. Attacker freezes all twin mint accounts
// 3. Users cannot unshield to twin mint
// 4. DoS attack on twin mint functionality

// Scenario 2: Mint authority compromise
// 1. Twin mint authority is compromised
// 2. Attacker mints unlimited twin tokens
// 3. Supply becomes incorrect
// 4. Invariant checks fail or are bypassed

// Scenario 3: Authority mismatch
// 1. Twin mint authority doesn't match expected
// 2. Operations fail or behave unexpectedly
// 3. Users cannot use twin mint features
// 4. System becomes unusable
```

## Code References

- Twin mint authority check: Lines 181-209 in `initialize_pool`
- Freeze authority validation: Factory lines 1025-1038
- Twin mint validation: Multiple locations in unshield operations

## Mitigation

1. **Strict Authority Validation**: Always validate twin mint authority matches expected value.

2. **Freeze Authority Enforcement**: Ensure freeze authority is always None or factory PDA.

3. **Authority Immutability**: Prevent authority changes after registration, or require timelock.

4. **Decimals Validation**: Strictly validate decimals match origin mint.

5. **Mint Verification**: Verify mint is valid SPL Token-2022 mint before use.

6. **Authority Monitoring**: Monitor authority changes and alert on suspicious activity.

7. **Recovery Mechanism**: Implement recovery mechanism for compromised authorities.

## Recommended Code Changes

```rust
// Enhanced twin mint validation
fn validate_twin_mint(
    twin_mint: &AccountInfo,
    expected_authority: &Pubkey,
    expected_decimals: u8,
) -> Result<()> {
    // Validate mint is Token-2022
    require_keys_eq!(
        *twin_mint.owner,
        spl_token_2022::ID,
        PoolError::InvalidTwinMint
    );
    
    // Read mint data
    let mint_data = twin_mint.try_borrow_data()?;
    let mint = Mint::try_deserialize(&mut &mint_data[..])?;
    
    // Validate decimals
    require!(
        mint.decimals == expected_decimals,
        PoolError::TwinMintDecimalsMismatch
    );
    
    // Validate mint authority
    match mint.mint_authority {
        COption::Some(auth) => {
            require_keys_eq!(
                auth,
                *expected_authority,
                PoolError::TwinMintAuthorityMismatch
            );
        }
        COption::None => {
            return err!(PoolError::TwinMintAuthorityMissing);
        }
    }
    
    // Validate freeze authority is None or factory
    match mint.freeze_authority {
        COption::Some(freeze_auth) => {
            // Only allow factory as freeze authority
            let (expected_factory, _) = Pubkey::find_program_address(
                &[seeds::FACTORY, ptf_factory::ID.as_ref()],
                &ptf_factory::ID,
            );
            require_keys_eq!(
                freeze_auth,
                expected_factory,
                PoolError::TwinMintFreezeAuthorityInvalid
            );
        }
        COption::None => {
            // None is acceptable
        }
    }
    
    Ok(())
}
```

