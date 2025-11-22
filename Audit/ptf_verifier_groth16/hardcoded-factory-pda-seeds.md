# Hardcoded Factory PDA Seeds

## Severity: MEDIUM

## Description

The verifier program hardcodes the factory PDA derivation seeds as `b"factory"` when validating the authority. If the factory program changes its PDA seed derivation (e.g., due to an upgrade or refactor), the verifier will incorrectly reject legitimate factory PDAs, or worse, accept incorrect PDAs if the seeds happen to match.

## Vulnerability Details

### Current Implementation

The code hardcodes the factory PDA seeds:

```rust
let (expected_factory_state, _) = Pubkey::find_program_address(
    &[b"factory", PTF_FACTORY_PROGRAM_ID.as_ref()],
    &PTF_FACTORY_PROGRAM_ID,
);
```

### Potential Vulnerabilities

1. **Factory Upgrade Incompatibility**: If the factory program is upgraded and changes its PDA seed derivation, the verifier will reject all new key registrations, breaking the system.

2. **Seed Mismatch**: If there's a discrepancy between what the factory actually uses and what the verifier expects, legitimate keys could be rejected or unauthorized keys could be accepted.

3. **Maintenance Risk**: Hardcoded seeds create a maintenance burden - any change to factory PDA derivation requires updating the verifier program.

4. **No Validation of Factory Seeds**: The verifier doesn't verify that the factory program actually uses these seeds - it just assumes they're correct.

## Exploitation Scenario

```rust
// Scenario 1: Factory upgrade breaks verifier
// 1. Factory program is upgraded
// 2. Factory changes PDA seed from "factory" to "factory_state"
// 3. Verifier still expects "factory" seed
// 4. All new key registrations fail
// 5. System becomes unusable

// Scenario 2: Seed mismatch
// 1. Factory program uses different seeds than verifier expects
// 2. Verifier rejects legitimate factory PDA
// 3. Keys cannot be registered
// 4. System is broken

// Scenario 3: Accidental seed collision
// 1. Another program uses same seeds "factory" + factory program ID
// 2. That program's PDA happens to match expected factory PDA
// 3. Verifier accepts keys from wrong program
// 4. Security is compromised
```

## Code References

- Factory PDA derivation: Lines 84-87
- Authority validation: Lines 88-92
- Hardcoded seed: `b"factory"` (line 85)

## Mitigation

1. **Use Common Seeds Module**: Import seeds from a shared `ptf_common` module that both factory and verifier use:

```rust
use ptf_common::seeds::FACTORY_STATE;

let (expected_factory_state, _) = Pubkey::find_program_address(
    &[FACTORY_STATE, PTF_FACTORY_PROGRAM_ID.as_ref()],
    &PTF_FACTORY_PROGRAM_ID,
);
```

2. **Factory PDA Validation via CPI**: Instead of hardcoding, query the factory program to validate the PDA:

```rust
// Call factory program to verify PDA
let factory_state = &ctx.accounts.factory_state;
let factory_program = &ctx.accounts.factory_program;

// Use CPI to verify the PDA is correct
// This ensures verifier always uses same seeds as factory
```

3. **Store Factory PDA in Verifier State**: Store the factory PDA address in the verifier's initialization and validate against stored value:

```rust
#[account]
pub struct VerifierConfig {
    pub factory_state_pda: Pubkey,
    // ... other config ...
}

// During initialization, store factory PDA
// During key registration, validate against stored PDA
```

4. **Versioned Seed Derivation**: If seeds must change, implement versioning:

```rust
pub fn get_factory_pda_seeds(version: u8) -> &'static [u8] {
    match version {
        1 => b"factory",
        2 => b"factory_state",
        _ => b"factory", // default
    }
}
```

5. **Documentation**: Clearly document the seed derivation and ensure it matches factory program exactly.

6. **Integration Tests**: Add tests that verify factory and verifier use the same PDA derivation.

