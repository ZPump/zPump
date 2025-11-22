# Token Program Validation

**Severity**: MEDIUM

## Description

The vault program accepts a `token_program` account but doesn't validate that it's actually a valid SPL Token or Token-2022 program. An attacker could potentially provide a malicious token program that behaves differently, leading to security vulnerabilities.

## Vulnerability Details

The vault uses `Interface<'info, TokenInterface>` for the token program:

```274:274:programs/vault/src/lib.rs
pub token_program: Interface<'info, TokenInterface>,
```

While `Interface` provides some validation, there's no explicit check that the token program is one of the expected programs:
- SPL Token program
- Token-2022 program

An attacker could potentially:
1. Provide a malicious token program that looks like a token program
2. Provide a different version of the token program
3. Provide a wrapped or proxied token program

## Exploitation Scenario

1. **Malicious Token Program**: 
   - Attacker creates a malicious program that implements TokenInterface
   - Attacker provides this program as token_program
   - Token transfers behave unexpectedly
   - Could lead to fund loss or manipulation

2. **Wrong Token Program Version**: 
   - Different versions of token program might have different behavior
   - Could lead to unexpected results
   - Compatibility issues

3. **Token Program Spoofing**: 
   - Attacker provides a program that mimics token program interface
   - But behaves maliciously
   - Could steal funds or manipulate balances

## Code References

```48:48:programs/vault/src/lib.rs
let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
```

```100:104:programs/vault/src/lib.rs
let cpi_ctx = CpiContext::new_with_signer(
    ctx.accounts.token_program.to_account_info(),
    cpi_accounts,
    signer,
);
```

## Mitigation

1. **Whitelist Token Programs**: Explicitly validate token program is one of the allowed programs:
   ```rust
   const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
   const SPL_TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
   
   require!(
       ctx.accounts.token_program.key() == SPL_TOKEN_PROGRAM_ID ||
       ctx.accounts.token_program.key() == SPL_TOKEN_2022_PROGRAM_ID,
       VaultError::InvalidTokenProgram
   );
   ```

2. **Use Known Program IDs**: Hardcode expected token program IDs and validate against them.

3. **Program ID Validation Function**: Create a helper function to validate token program:
   ```rust
   fn validate_token_program(program: &Pubkey) -> Result<()> {
       require!(
           program == &spl_token::ID || program == &spl_token_2022::ID,
           VaultError::InvalidTokenProgram
       );
       Ok(())
   }
   ```

## Recommended Code Changes

```rust
use spl_token;
use spl_token_2022;

fn validate_token_program(program: &Pubkey) -> Result<()> {
    require!(
        program == &spl_token::ID || program == &spl_token_2022::ID,
        VaultError::InvalidTokenProgram
    );
    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidDepositAmount);
    
    // CRITICAL FIX: Validate token program
    validate_token_program(ctx.accounts.token_program.key())?;
    
    let vault_state = &mut ctx.accounts.vault_state;
    
    // REENTRANCY GUARD
    require!(!vault_state.locked, VaultError::ReentrancyDetected);
    vault_state.locked = true;
    
    // ... rest of deposit logic ...
}

pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidReleaseAmount);
    
    // CRITICAL FIX: Validate token program
    validate_token_program(ctx.accounts.token_program.key())?;
    
    // ... rest of release logic ...
}

#[error_code]
pub enum VaultError {
    // ... existing errors ...
    #[msg("E_INVALID_TOKEN_PROGRAM")]
    InvalidTokenProgram,
}
```

## Additional Considerations

- Consider allowing only one token program (e.g., only Token-2022) if both aren't needed.
- Add validation in account structs using Anchor constraints.
- Consider making token program configurable per vault (via timelock).
- Document which token programs are supported.

