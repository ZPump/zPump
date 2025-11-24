# Timelock Entry PDA Collision Risk

## Severity: MEDIUM

## Description

Timelock entries use PDA derivation with `factory_state.key()`, `salt`, and `sequence`. While the sequence should prevent collisions, if the sequence overflows or if there's a bug in sequence management, PDAs could collide.

## Vulnerability Details

### Current Implementation

The timelock entry PDA is derived using:
- `factory_state.key()`
- `salt` (provided by caller)
- `sequence` (from `factory_state.last_action_sequence`)

### Potential Vulnerabilities

1. **Sequence Overflow**: If sequence overflows (though `checked_add` prevents this), different actions might try to use the same PDA.

2. **Salt Reuse**: If the same salt is used with the same sequence (shouldn't happen, but if sequence management is buggy), PDAs could collide.

3. **PDA Derivation Bug**: If there's a bug in the PDA derivation seeds, collisions are possible.

4. **Race Condition**: If two transactions queue actions simultaneously, they might get the same sequence number, causing PDA collision.

## Exploitation Scenario

```rust
// Scenario: Sequence collision
// 1. Two transactions read same sequence number
// 2. Both try to create timelock entry with same sequence
// 3. PDA collision
// 4. One transaction fails or overwrites the other
// 5. Actions are lost or corrupted
```

## Code References

- Timelock entry PDA derivation (in QueueTimelockAction context)
- Sequence management: Lines 340-343, 424-427

## Mitigation

1. **Ensure atomic sequence increment**:
```rust
// CRITICAL FIX: Sequence increment should be atomic
// Anchor's PDA constraint should handle this, but verify
let current_sequence = state.last_action_sequence;
let next_sequence = current_sequence
    .checked_add(1)
    .ok_or(FactoryError::SequenceOverflow)?;

// Increment immediately to prevent reuse
state.last_action_sequence = next_sequence;

// Then create entry with current_sequence (matches PDA)
```

2. **Validate PDA uniqueness**:
```rust
// Before creating entry, verify PDA doesn't exist
// This is handled by Anchor's init constraint, but add explicit check
let entry_info = &ctx.accounts.timelock_entry;
if entry_info.data_len() > 0 {
    // Entry already exists - this shouldn't happen
    return err!(FactoryError::DuplicateTimelockEntry);
}
```

3. **Add salt validation**:
```rust
// Validate salt is not all zeros (defense in depth)
require!(
    salt != [0u8; 32],
    FactoryError::InvalidSalt
);
```

4. **Add monitoring**:
```rust
// Log when sequence is incremented
// Monitor for sequence collisions
// Alert if sequence approaches limits
```

## Additional Considerations

- Anchor's PDA constraint should prevent collisions
- But sequence management is critical
- Consider whether salt should be required or optional
- Add comprehensive tests for sequence edge cases

