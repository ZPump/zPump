# Duplicate Sequence Calculation in queue_timelock_action

**Severity:** MEDIUM

**Location:** `programs/factory/src/lib.rs:342-345` and `426-429`

## Description

The `queue_timelock_action` function calculates `current_sequence` and `next_sequence` twice - once at lines 342-345 and again at lines 426-429. While this doesn't cause a bug (both calculations are identical), it's redundant code that could lead to maintenance issues.

## Code Reference

### First calculation (lines 342-345):
```rust
// CRITICAL FIX: Use sequence for unique entry address
// Anchor's PDA constraint reads factory_state.last_action_sequence BEFORE the instruction runs
// So the PDA seeds use the CURRENT sequence value. We set entry.sequence to match the PDA.
// Then we increment state.last_action_sequence AFTER creating the account.
let current_sequence = state.last_action_sequence;
let next_sequence = current_sequence
    .checked_add(1)
    .ok_or(FactoryError::SequenceOverflow)?;
```

### Second calculation (lines 426-429):
```rust
// CRITICAL FIX: Use sequence for unique entry address
// Anchor's PDA constraint reads factory_state.last_action_sequence BEFORE the instruction runs
// So the PDA seeds use the CURRENT sequence value. We set entry.sequence to match the PDA.
// Then we increment state.last_action_sequence AFTER creating the account.
let current_sequence = state.last_action_sequence;
let next_sequence = current_sequence
    .checked_add(1)
    .ok_or(FactoryError::SequenceOverflow)?;
```

## Impact

- Code duplication increases maintenance burden
- Risk of inconsistent changes if one calculation is modified but not the other
- Slight performance overhead (minimal)

## Recommendation

1. Remove the duplicate calculation
2. Keep only one calculation before the entry creation
3. Reuse the variables throughout the function
4. Add a comment explaining why sequence is calculated before entry creation

