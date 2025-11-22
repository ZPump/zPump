# PDA Seed Manipulation and Validation

## Severity: HIGH

## Description

Program Derived Addresses (PDAs) are critical for account security. If PDA seeds can be manipulated or validation is insufficient, attackers could access or manipulate accounts they shouldn't have access to.

## Vulnerability Details

### Current Implementation

PDA derivation and validation:
- Multiple PDAs with different seeds (pool, tree, ledger, nullifiers, etc.)
- Seed validation using `find_program_address` and `require_keys_eq`
- Bump seeds stored in accounts and validated

### Potential Vulnerabilities

1. **Seed Collision**: If seeds can collide, wrong accounts could be accessed.

2. **Bump Seed Manipulation**: If bump seeds aren't properly validated, wrong accounts could be used.

3. **Seed Ordering**: If seed ordering matters and isn't consistent, PDAs could be miscalculated.

4. **Program ID Validation**: If program IDs in seeds aren't validated, cross-program attacks could occur.

5. **Seed Injection**: If user-provided seeds aren't validated, malicious seeds could be injected.

6. **PDA Reuse**: If the same PDA is used for multiple purposes, confusion could occur.

7. **Seed Length**: If seed lengths aren't validated, edge cases could be exploited.

## Exploitation Scenario

```rust
// Scenario 1: Bump seed manipulation
// 1. Attacker finds way to use wrong bump seed
// 2. PDA validation passes with wrong bump
// 3. Attacker accesses wrong account
// 4. Attacker manipulates account data

// Scenario 2: Seed collision
// 1. Attacker finds seeds that collide with legitimate PDAs
// 2. Attacker creates account with colliding seeds
// 3. Validation might pass incorrectly
// 4. Attacker gains unauthorized access

// Scenario 3: Program ID manipulation
// 1. Attacker provides wrong program ID in seed calculation
// 2. PDA validation doesn't catch program ID mismatch
// 3. Attacker accesses account from different program
// 4. Security is compromised
```

## Code References

- PDA derivation: Multiple `find_program_address` calls throughout
- Seed validation: `require_keys_eq` checks for PDA addresses
- Bump validation: Bump seeds stored and validated in accounts

## Mitigation

1. **Strict Bump Validation**: Always validate bump seeds match expected values.

2. **Seed Canonicalization**: Canonicalize seeds before PDA derivation to prevent ordering issues.

3. **Program ID Validation**: Explicitly validate program IDs in seed calculations.

4. **Seed Length Limits**: Validate seed lengths to prevent edge cases.

5. **PDA Uniqueness**: Ensure PDAs are unique and not reused for different purposes.

6. **Comprehensive Validation**: Validate all aspects of PDA derivation, not just the final address.

7. **Seed Sanitization**: Sanitize and validate all user-provided seeds.

8. **PDA Testing**: Add comprehensive tests for PDA derivation edge cases.

## Recommended Code Changes

```rust
// Enhanced PDA validation helper
fn validate_pda(
    account: &AccountInfo,
    expected_seeds: &[&[u8]],
    expected_program: &Pubkey,
) -> Result<u8> {
    // Derive expected PDA
    let (expected_pda, expected_bump) = Pubkey::find_program_address(
        expected_seeds,
        expected_program,
    );
    
    // Validate address matches
    require_keys_eq!(
        account.key(),
        expected_pda,
        PoolError::PdaMismatch
    );
    
    // Validate program ownership
    require_keys_eq!(
        *account.owner,
        *expected_program,
        PoolError::PdaProgramMismatch
    );
    
    Ok(expected_bump)
}

// Seed canonicalization
fn canonicalize_seeds(seeds: &[&[u8]]) -> Vec<Vec<u8>> {
    // Ensure consistent ordering and format
    seeds.iter().map(|s| s.to_vec()).collect()
}

// Enhanced validation with seed checking
fn validate_pool_pda(
    pool_state: &AccountInfo,
    origin_mint: &Pubkey,
) -> Result<u8> {
    let expected_seeds = &[
        seeds::POOL,
        origin_mint.as_ref(),
    ];
    
    validate_pda(
        pool_state,
        expected_seeds,
        &crate::ID,
    )
}

// Bump seed validation
fn validate_bump(
    account: &AccountInfo,
    expected_bump: u8,
) -> Result<()> {
    // Re-derive to get bump
    let (_, bump) = Pubkey::find_program_address(
        // ... seeds ...
        &crate::ID,
    );
    
    require!(
        bump == expected_bump,
        PoolError::BumpMismatch
    );
    
    Ok(())
}
```

