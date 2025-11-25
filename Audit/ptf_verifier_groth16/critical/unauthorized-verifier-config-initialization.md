# Verifier Config Can Be Hijacked During Initialization

**Status:** ⚠️ NEW ISSUE

**Severity:** CRITICAL

**Location:** `programs/verifier-groth16/src/lib.rs:401-428` (initialize_verifier_config)

## Description

The `initialize_verifier_config` instruction sets the global factory program ID and authority for the verifier. It performs no authorization check—any signer can initialize this singleton PDA with arbitrary values. Because the verifier relies on this config to validate who may register verifying keys, an attacker who initializes it first can choose a permissive `factory_program_id` and take over verifying-key registration.

## Code Reference

### initialize_verifier_config (line 401-428):
```rust
pub fn initialize_verifier_config(
    ctx: Context<InitializeVerifierConfig>,
    factory_program_id: Pubkey,
) -> Result<()> {
    // Validate factory program ID is executable
    require!(
        ctx.accounts.factory_program.executable,
        VerifierError::InvalidProgramId
    );
    require_keys_eq!(
        ctx.accounts.factory_program.key(),
        factory_program_id,
        VerifierError::InvalidProgramId
    );

    let config = &mut ctx.accounts.verifier_config;
    config.factory_program_id = factory_program_id;
    config.authority = ctx.accounts.authority.key();
    config.bump = ctx.bumps.verifier_config;

    emit!(VerifierConfigInitialized {
        factory_program_id,
        authority: config.authority,
    });

    Ok(())
}
```

## Issue

Anyone can initialize `verifier_config` and set both the authority and `factory_program_id`. The subsequent `initialize_verifying_key` authorization relies on the config by checking that the signer is owned by the configured factory program and matches the factory_state PDA. If an attacker sets `factory_program_id` to `system_program::ID`, any keypair (owner = system program) can satisfy the ownership requirement, and the attacker-controlled authority signer will pass the PDA check when seeds are derived with the fake program ID. This enables unrestricted registration of arbitrary verifying keys without factory governance.

## Impact

- **Attack scenario:** Attacker front-runs deployment, initializes `verifier_config` with `factory_program_id = system_program::ID` and their own key as `authority`.
- **Potential loss:** Attacker can register forged verifying keys that bypass intended factory approval, undermining proof verification integrity across the protocol.
- **Likelihood:** High whenever the config is uninitialized; the instruction requires no privileged signer.

## Attack Scenario

1. Observe verifier program deployment before governance initializes the config.
2. Call `initialize_verifier_config` using the attacker's signer and `factory_program_id = system_program::ID`.
3. Use the attacker signer (owner = system program) to satisfy the authority checks in `initialize_verifying_key` and register arbitrary verifying keys.
4. Pools relying on the verifier accept attacker-registered keys, compromising proof validation.

## Current Mitigations

None. There is no authority or PDA check during initialization.

## Recommendation

Require the intended verifier authority (e.g., factory authority) to sign initialization and validate that the factory program ID matches the real factory program.

### Suggested Fix:
```rust
pub fn initialize_verifier_config(
    ctx: Context<InitializeVerifierConfig>,
    factory_program_id: Pubkey,
) -> Result<()> {
    // Require explicit authority approval
    require_keys_eq!(
        ctx.accounts.authority.key(),
        EXPECTED_AUTHORITY,
        VerifierError::UnauthorizedAuthority,
    );
    require!(ctx.accounts.factory_program.executable, VerifierError::InvalidProgramId);
    require_keys_eq!(ctx.accounts.factory_program.key(), factory_program_id, VerifierError::InvalidProgramId);

    let config = &mut ctx.accounts.verifier_config;
    config.factory_program_id = factory_program_id;
    config.authority = ctx.accounts.authority.key();
    config.bump = ctx.bumps.verifier_config;
    Ok(())
}
```

## Related Code

- `programs/verifier-groth16/src/lib.rs:401-428` - `initialize_verifier_config` lacks any authority requirement.
- `programs/verifier-groth16/src/lib.rs:86-113` - `initialize_verifying_key` authorization derives from attacker-controlled config values.
