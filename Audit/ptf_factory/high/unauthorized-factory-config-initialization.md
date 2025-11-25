# Missing Authority Check in Factory Config Initialization

**Status:** ⚠️ NEW ISSUE

**Severity:** HIGH

**Location:** `programs/factory/src/lib.rs:81-100` (initialize_factory_config)

## Description

The `initialize_factory_config` instruction creates the `FactoryConfig` account that sets the pool and verifier program IDs. However, it does not require the factory authority to approve the initialization. Any signer who can provide the `factory_state` account can front-run and initialize the config with arbitrary program IDs.

## Code Reference

### initialize_factory_config (line 81-100):
```rust
pub fn initialize_factory_config(
    ctx: Context<InitializeFactoryConfig>,
    pool_program_id: Pubkey,
    verifier_program_id: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.factory_config;
    config.factory = ctx.accounts.factory_state.key();
    config.pool_program_id = pool_program_id;
    config.verifier_program_id = verifier_program_id;
    config.authority = ctx.accounts.factory_state.authority;
    config.bump = ctx.bumps.factory_config;

    emit!(FactoryConfigInitialized {
        factory: config.factory,
        pool_program_id,
        verifier_program_id,
        authority: config.authority,
    });
    Ok(())
}
```

## Issue

`initialize_factory_config` lacks any signer or authority constraint, and the `InitializeFactoryConfig` accounts context similarly omits an `authority` field. As a result, any user can create the singleton `factory_config` PDA before governance does. They can set `pool_program_id` and `verifier_program_id` to attacker-controlled programs and permanently block the legitimate authority from deploying a valid configuration because the PDA is already initialized.

## Impact

- **Attack scenario:** An attacker calls `initialize_factory_config` first with malicious program IDs. Subsequent governance attempts to create the config will fail because the PDA already exists.
- **Potential loss:** The factory can be bricked or pointed at malicious pool/verifier programs, preventing legitimate mint registrations or routing users to compromised programs.
- **Likelihood:** High, because no authorization is required and the PDA can only be initialized once.

## Attack Scenario

1. Attacker observes factory deployment and obtains the `factory_state` address (public PDA).
2. Attacker calls `initialize_factory_config` with arbitrary `pool_program_id`/`verifier_program_id` before governance does.
3. The attacker-controlled config is persisted; governance cannot reinitialize or correct it without program upgrades.
4. Pool initialization and mint registration will depend on attacker-chosen program IDs, leading to DoS or redirection to malicious programs.

## Current Mitigations

None. The instruction performs no signer or ownership checks beyond PDA derivation.

## Recommendation

Require the factory authority to authorize config creation and verify the provided program IDs belong to executable programs.

### Suggested Fix:
```rust
pub fn initialize_factory_config(
    ctx: Context<InitializeFactoryConfig>,
    pool_program_id: Pubkey,
    verifier_program_id: Pubkey,
) -> Result<()> {
    // Require factory authority signature
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.factory_state.authority,
        FactoryError::Unauthorized
    );

    // Validate program executability
    require!(ctx.accounts.pool_program.executable, FactoryError::InvalidProgram);
    require!(ctx.accounts.verifier_program.executable, FactoryError::InvalidProgram);

    let config = &mut ctx.accounts.factory_config;
    config.factory = ctx.accounts.factory_state.key();
    config.pool_program_id = pool_program_id;
    config.verifier_program_id = verifier_program_id;
    config.authority = ctx.accounts.factory_state.authority;
    config.bump = ctx.bumps.factory_config;
    Ok(())
}
```

## Related Code

- `programs/factory/src/lib.rs:81-100` - `initialize_factory_config` lacks authorization.
- `programs/factory/src/lib.rs:998-1016` - `InitializeFactoryConfig` context omits authority signer and program validation.
