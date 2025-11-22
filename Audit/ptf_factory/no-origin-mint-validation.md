# No Validation of Origin Mint Account

## Severity: HIGH

## Description

The `origin_mint` account in `register_mint` is an `UncheckedAccount` with only a `CHECK` comment. There's no validation that it's actually a valid SPL token mint account, that it's owned by the correct token program, or that its decimals match the provided `decimals` parameter. This could allow invalid mints to be registered or mints with incorrect decimals.

## Vulnerability Details

### Current Implementation

```rust
/// CHECK: The factory only records the origin mint address.
pub origin_mint: UncheckedAccount<'info>,
```

The code:
- Only stores the mint's public key (line 103, 117)
- Does NOT validate it's a valid mint account
- Does NOT validate it's owned by token program
- Does NOT validate decimals match the actual mint
- Does NOT validate mint authority or other mint properties

### Potential Vulnerabilities

1. **Invalid Mint Registration**: An attacker could register a non-mint account (e.g., a token account, program, or arbitrary account) as an "origin mint", leading to system confusion and potential failures.

2. **Decimals Mismatch**: The `decimals` parameter is provided but not validated against the actual mint's decimals. If they don't match, the system will have incorrect decimal information.

3. **Wrong Token Program**: If the mint is owned by a different token program (e.g., old SPL Token vs Token-2022), this isn't validated.

4. **Mint Authority Issues**: No validation of mint authority, which could lead to issues if the mint has unexpected authority settings.

5. **System Confusion**: Invalid mints could cause failures in downstream operations (e.g., pool initialization, PTKN minting).

## Exploitation Scenario

```rust
// Scenario 1: Invalid account registration
// 1. Attacker provides a token account (not a mint) as origin_mint
// 2. Factory registers it as a mint
// 3. Pool tries to initialize with this "mint"
// 4. Pool initialization fails or behaves unexpectedly
// 5. System becomes unusable

// Scenario 2: Decimals mismatch
// 1. Attacker registers mint with decimals=9
// 2. Actual mint has decimals=6
// 3. System uses wrong decimals for calculations
// 4. Amount calculations are incorrect
// 5. Users receive wrong amounts

// Scenario 3: Wrong token program
// 1. Attacker provides mint from old SPL Token program
// 2. System expects Token-2022
// 3. Operations fail or behave unexpectedly
// 4. System breaks
```

## Code References

- Origin mint account: Line 682 - `UncheckedAccount<'info>`
- Registration: Lines 80-152
- No validation of mint properties
- Decimals parameter: Line 82, but not validated against actual mint

## Mitigation

1. **Validate Mint Account**: Add validation that the account is a valid mint:

```rust
pub fn register_mint(
    ctx: Context<RegisterMint>,
    decimals: u8,
    enable_ptkn: bool,
    feature_flags: Option<u8>,
    fee_bps_override: Option<u16>,
) -> Result<()> {
    // ... existing checks ...
    
    // Validate origin_mint is a valid mint account
    validate_mint_account(&ctx.accounts.origin_mint, decimals)?;
    
    // ... rest of function ...
}

fn validate_mint_account(mint_info: &AccountInfo, expected_decimals: u8) -> Result<()> {
    // Check account is owned by a token program
    // Note: This is a simplified check - in practice, you'd want to check
    // against known token program IDs (Token Program, Token-2022)
    let token_program_ids = [
        anchor_spl::token::ID,  // SPL Token
        anchor_spl::token_2022::ID,  // Token-2022
    ];
    
    require!(
        token_program_ids.contains(mint_info.owner),
        FactoryError::InvalidMintAccount
    );
    
    // Validate account data is a valid mint
    let mint_data = mint_info
        .try_borrow_data()
        .map_err(|_| error!(FactoryError::InvalidMintAccount))?;
    
    // Check minimum size for mint account
    require!(
        mint_data.len() >= 82,  // Minimum size for SPL Token mint
        FactoryError::InvalidMintAccount
    );
    
    // Deserialize and validate mint
    let mut slice: &[u8] = &mint_data;
    let mint = Mint::try_deserialize(&mut slice)
        .map_err(|_| error!(FactoryError::InvalidMintAccount))?;
    
    // Validate decimals match
    require!(
        mint.decimals == expected_decimals,
        FactoryError::DecimalsMismatch
    );
    
    // Validate mint authority exists (mints should have authority)
    require!(
        mint.mint_authority.is_some(),
        FactoryError::InvalidMintAccount
    );
    
    Ok(())
}
```

2. **Use InterfaceAccount**: If possible, use `InterfaceAccount<'info, Mint>` instead of `UncheckedAccount`:

```rust
#[derive(Accounts)]
pub struct RegisterMint<'info> {
    // ... other accounts ...
    pub origin_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    // ... rest ...
}
```

3. **Add Error Types**: Add error variants for validation failures:

```rust
#[error_code]
pub enum FactoryError {
    // ... existing errors ...
    #[msg("origin mint is not a valid mint account")]
    InvalidMintAccount,
    #[msg("mint decimals do not match provided decimals")]
    DecimalsMismatch,
}
```

4. **Validate in register_mint**: Add explicit validation before storing:

```rust
// Validate mint before registration
let mint = InterfaceAccount::<Mint>::try_from(&ctx.accounts.origin_mint)
    .map_err(|_| error!(FactoryError::InvalidMintAccount))?;

require!(
    mint.decimals == decimals,
    FactoryError::DecimalsMismatch
);

// ... then proceed with registration ...
```

5. **Document Requirements**: Clearly document that origin_mint must be a valid SPL token mint account.

