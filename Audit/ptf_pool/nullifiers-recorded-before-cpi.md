# Nullifiers Recorded Before CPI

## Severity: HIGH

## Description

In `process_unshield`, nullifiers are recorded immediately after proof verification (line 1444) but before the CPI to vault release (line 1592) or factory mint_ptkn (line 1632). If the CPI fails, nullifiers are already recorded, making the notes permanently unspendable even though no tokens were released. This creates a critical loss of funds scenario.

## Vulnerability Details

### Current Implementation

```rust
// 1. Proof verification (line 1429)
ptf_verifier_groth16::cpi::verify_groth16(...)?;

// 2. Record nullifiers (line 1444) - BEFORE CPI
for nullifier in &args.nullifiers {
    NullifierSet::insert(...)?;
}

// 3. Update state (lines 1531, 1533, 1546)
pool_state.push_root(new_root);
note_ledger.record_unshield(...)?;
pool_state.protocol_fees = ...;

// 4. CPI to vault/factory (lines 1592, 1632) - AFTER nullifiers recorded
invoke_signed(&release_ix, ...)?;  // or ptf_factory::cpi::mint_ptkn(...)?;
```

The sequence:
- Nullifiers are recorded first (line 1444)
- State is updated (lines 1531-1549)
- CPI is called last (lines 1592, 1632)
- If CPI fails, nullifiers are already recorded

### Potential Vulnerabilities

1. **Permanent Fund Loss**: If vault release or factory mint_ptkn fails after nullifiers are recorded, the notes become permanently unspendable, but no tokens were released.

2. **State Inconsistency**: Pool state (roots, ledger, fees) is updated, but tokens weren't actually released, creating inconsistency.

3. **Replay Prevention Broken**: Nullifiers prevent replay, but if CPI fails, the same proof cannot be retried even though it's valid.

4. **No Rollback Mechanism**: Once nullifiers are recorded, there's no way to rollback the state changes if CPI fails.

5. **DoS Attack Vector**: If an attacker can cause CPI to fail (e.g., by manipulating vault state), they can cause permanent fund loss.

## Exploitation Scenario

```rust
// Scenario 1: Vault release failure
// 1. User submits valid unshield proof
// 2. Proof is verified
// 3. Nullifiers are recorded (notes marked as spent)
// 4. Pool state is updated
// 5. Vault release CPI fails (e.g., vault is paused, insufficient balance, etc.)
// 6. Transaction fails, but nullifiers are already recorded
// 7. Notes are permanently unspendable
// 8. User loses funds

// Scenario 2: Factory mint_ptkn failure
// 1. User submits valid unshield_to_ptkn proof
// 2. Proof is verified
// 3. Nullifiers are recorded
// 4. Pool state is updated
// 5. Factory mint_ptkn CPI fails (e.g., mint frozen, factory paused, etc.)
// 6. Transaction fails, but nullifiers are already recorded
// 7. Notes are permanently unspendable
// 8. User loses funds

// Scenario 3: DoS attack
// 1. Attacker manipulates vault state to cause release to fail
// 2. Legitimate users submit unshield proofs
// 3. Nullifiers are recorded
// 4. CPI fails
// 5. Users lose funds
```

## Code References

- Nullifier recording: Lines 1436-1451
- State updates: Lines 1531-1549
- CPI calls: Lines 1592 (vault release), 1632 (factory mint_ptkn)
- Order: Nullifiers → State → CPI

## Mitigation

1. **Move Nullifier Recording After CPI**: Record nullifiers only after successful CPI:

```rust
// 1. Proof verification
ptf_verifier_groth16::cpi::verify_groth16(...)?;

// 2. Validate public inputs
let fee = validate_unshield_public_inputs(...)?;

// 3. Update state (but don't record nullifiers yet)
pool_state.push_root(new_root);
note_ledger.record_unshield(...)?;
pool_state.protocol_fees = ...;

// 4. CPI to vault/factory FIRST
invoke_signed(&release_ix, ...)?;  // or ptf_factory::cpi::mint_ptkn(...)?;

// 5. Record nullifiers AFTER successful CPI
for nullifier in &args.nullifiers {
    NullifierSet::insert(...)?;
}
```

2. **Use Transaction Rollback**: Leverage Solana's transaction atomicity - if CPI fails, entire transaction should fail and rollback. However, this requires ensuring nullifiers aren't recorded until after CPI.

3. **Add Retry Mechanism**: If CPI fails, allow retrying the same proof (though this requires careful nullifier handling).

4. **Two-Phase Commit**: Use a two-phase approach:
   - Phase 1: Verify proof, validate inputs
   - Phase 2: CPI, then record nullifiers

5. **State Checkpoint**: Before recording nullifiers, ensure all prerequisites for CPI are met (vault not paused, sufficient balance, etc.).

6. **Error Handling**: Add explicit checks before CPI to reduce failure probability:

```rust
// Before CPI, validate vault state
let vault_state = ctx.accounts.vault_state.load()?;
require!(!vault_state.paused, PoolError::VaultPaused);
// ... other checks ...

// Then CPI
invoke_signed(&release_ix, ...)?;

// Only then record nullifiers
for nullifier in &args.nullifiers {
    NullifierSet::insert(...)?;
}
```

Note: The current order (nullifiers before CPI) is intentional to prevent replay attacks, but it creates a critical vulnerability if CPI fails. The mitigation must balance security (preventing replays) with safety (preventing fund loss).

