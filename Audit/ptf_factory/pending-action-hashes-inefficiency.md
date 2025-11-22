# Pending Action Hashes Vector Inefficiency

**Severity**: MEDIUM

## Description

The `pending_action_hashes` vector uses `retain()` operations which are O(n) and could be inefficient, especially as the vector grows. Additionally, if cleanup operations fail or entries are not properly removed, the vector could accumulate stale entries, potentially leading to DoS or incorrect duplicate detection.

## Vulnerability Details

The `pending_action_hashes` vector is used to track pending timelock actions and prevent duplicates:

```849:850:programs/factory/src/lib.rs
// CRITICAL FIX: Track pending action hashes to prevent duplicates
pub pending_action_hashes: Vec<[u8; 32]>,
```

The vector is modified using `retain()` which is O(n):

```497:497:programs/factory/src/lib.rs
state.pending_action_hashes.retain(|&h| h != entry.action_hash);
```

This operation is called in:
- `execute_timelock_action` (line 497)
- `cancel_timelock_action` (line 518)
- `cleanup_timelock_action` (line 560)

## Exploitation Scenario

1. **DoS via Vector Growth**: If cleanup operations fail or are not called, the vector could grow to `MAX_PENDING_ACTIONS` (50), making each `retain()` operation more expensive.

2. **Stale Entry Accumulation**: If timelock entries are not properly cleaned up (e.g., due to transaction failures), stale hashes could accumulate in the vector, potentially:
   - Causing false positives in duplicate detection
   - Consuming unnecessary compute units
   - Making the vector operations slower

3. **Inefficient Duplicate Detection**: The `contains()` check is O(n):

```270:273:programs/factory/src/lib.rs
require!(
    !state.pending_action_hashes.contains(&action_hash.to_bytes()),
    FactoryError::DuplicateAction
);
```

As the vector grows, this becomes increasingly expensive.

## Code References

```269:273:programs/factory/src/lib.rs
// CRITICAL FIX: Check for duplicate actions
require!(
    !state.pending_action_hashes.contains(&action_hash.to_bytes()),
    FactoryError::DuplicateAction
);
```

```321:321:programs/factory/src/lib.rs
state.pending_action_hashes.push(action_hash.to_bytes());
```

```497:497:programs/factory/src/lib.rs
state.pending_action_hashes.retain(|&h| h != entry.action_hash);
```

```518:518:programs/factory/src/lib.rs
state.pending_action_hashes.retain(|&h| h != entry.action_hash);
```

```560:560:programs/factory/src/lib.rs
state.pending_action_hashes.retain(|&h| h != entry.action_hash);
```

## Mitigation

1. **Use HashSet Instead of Vec**: Replace `Vec<[u8; 32]>` with a more efficient data structure. However, Anchor doesn't support `HashSet` directly, so this would require custom serialization.

2. **Use BTreeSet**: Consider using `BTreeSet<[u8; 32]>` which provides O(log n) operations and is supported by Anchor with custom serialization.

3. **Optimize Removal**: Instead of using `retain()`, track the index of the hash when adding and remove by index (O(1) if at end, O(n) if in middle).

4. **Periodic Cleanup**: Implement a periodic cleanup mechanism to remove stale entries.

5. **Limit Vector Size**: The `MAX_PENDING_ACTIONS` limit (50) helps, but consider if this is sufficient.

## Recommended Code Changes

Option 1: Use index tracking for O(1) removal:

```rust
#[account]
pub struct FactoryState {
    // ... existing fields ...
    pub pending_action_hashes: Vec<[u8; 32]>,
    pub pending_action_indices: Vec<u64>, // Map sequence -> index in pending_action_hashes
}

// When adding:
let index = state.pending_action_hashes.len();
state.pending_action_hashes.push(action_hash.to_bytes());
state.pending_action_indices.push(entry.sequence);

// When removing:
if let Some(pos) = state.pending_action_indices.iter().position(|&seq| seq == entry.sequence) {
    state.pending_action_hashes.swap_remove(pos);
    state.pending_action_indices.swap_remove(pos);
}
```

Option 2: Use a more efficient data structure (requires custom serialization):

```rust
use std::collections::BTreeSet;

#[account]
pub struct FactoryState {
    // ... existing fields ...
    // Note: This requires custom serialization/deserialization
    pub pending_action_hashes: BTreeSet<[u8; 32]>,
}
```

Option 3: Keep Vec but optimize operations:

```rust
// When removing, find index first, then swap_remove (O(1) if last element)
if let Some(pos) = state.pending_action_hashes.iter().position(|&h| h == entry.action_hash) {
    state.pending_action_hashes.swap_remove(pos);
}
```

## Additional Considerations

- Monitor the size of `pending_action_hashes` and alert if it approaches `MAX_PENDING_ACTIONS`.
- Consider implementing a background cleanup job to remove stale entries.
- Evaluate whether `MAX_PENDING_ACTIONS` (50) is appropriate for the use case.

