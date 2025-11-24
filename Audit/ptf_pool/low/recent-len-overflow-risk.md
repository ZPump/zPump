# Recent Commitments Length Overflow Risk

**Severity:** LOW

**Location:** `programs/pool/src/lib.rs:3986-4002` (record_recent function)

## Description

The `record_recent` function in `CommitmentTree` increments `recent_len` when it's less than `MAX_CANOPY`, but when `recent_len >= MAX_CANOPY`, it shifts the array without updating `recent_len`. While `recent_len` is a `u8` and `MAX_CANOPY` is 16, there's no validation to ensure `recent_len` doesn't exceed `MAX_CANOPY` if state is corrupted.

## Code Reference

### record_recent Function (line 3986-4002):
```rust
fn record_recent(&mut self, index: u64, commitment: [u8; 32], amount_commit: [u8; 32]) {
    if (self.recent_len as usize) < Self::MAX_CANOPY {
        let idx = self.recent_len as usize;
        self.recent_commitments[idx] = commitment;
        self.recent_amount_commitments[idx] = amount_commit;
        self.recent_indices[idx] = index;
        self.recent_len += 1;  // Increments until MAX_CANOPY
    } else {
        // Shifts array but doesn't update recent_len
        self.recent_commitments.copy_within(1..Self::MAX_CANOPY, 0);
        self.recent_amount_commitments
            .copy_within(1..Self::MAX_CANOPY, 0);
        self.recent_indices.copy_within(1..Self::MAX_CANOPY, 0);
        self.recent_commitments[Self::MAX_CANOPY - 1] = commitment;
        self.recent_amount_commitments[Self::MAX_CANOPY - 1] = amount_commit;
        self.recent_indices[Self::MAX_CANOPY - 1] = index;
        // NOTE: recent_len is NOT updated here - it stays at MAX_CANOPY or higher
    }
}
```

### Constants:
- `MAX_CANOPY: usize = 16` (line 3599)
- `recent_len: u8` (line 3593)

## Issue

1. **No validation of recent_len bounds** - If `recent_len` is corrupted to be > `MAX_CANOPY` (but still a valid `u8`, e.g., 17-255), the function will always take the `else` branch and shift the array, but `recent_len` will remain corrupted.

2. **Potential out-of-bounds if logic changes** - While the current logic is safe (it uses `MAX_CANOPY - 1` for indexing), if the code is modified to use `recent_len` for indexing in the `else` branch, it could cause out-of-bounds access.

3. **State inconsistency** - `recent_len` could become inconsistent with the actual number of valid entries if state is corrupted.

## Impact

- **Low impact** since:
  - Current code uses fixed `MAX_CANOPY - 1` for indexing in the `else` branch (safe)
  - `recent_len` is only used for indexing in the `if` branch (bounds checked)
  - Array size is fixed (`MAX_CANOPY = 16`), preventing unbounded growth
- **Defensive programming gap** - Missing validation that could catch state corruption early

## Attack Scenario

1. Attacker finds a way to corrupt `recent_len` to be > `MAX_CANOPY` (unlikely but possible through bugs)
2. `recent_len` stays at corrupted value
3. Operations continue, but `recent_len` is inconsistent with actual state
4. Could lead to unexpected behavior if code is modified to rely on `recent_len` in the `else` branch

## Current Mitigations

- Array size is fixed (`MAX_CANOPY = 16`)
- Indexing in `else` branch uses fixed `MAX_CANOPY - 1` (not `recent_len`)
- `recent_len` is only used for indexing in the `if` branch (bounds checked)
- However, no runtime validation of `recent_len` bounds

## Recommendation

1. **Add bounds validation** at the start of `record_recent`:
   ```rust
   fn record_recent(&mut self, index: u64, commitment: [u8; 32], amount_commit: [u8; 32]) {
       // CRITICAL FIX: Validate recent_len is within bounds
       if (self.recent_len as usize) > Self::MAX_CANOPY {
           // Cap to MAX_CANOPY if corrupted
           self.recent_len = Self::MAX_CANOPY as u8;
       }
       
       if (self.recent_len as usize) < Self::MAX_CANOPY {
           // ... existing code
       } else {
           // ... existing code
           // CRITICAL FIX: Keep recent_len at MAX_CANOPY (don't let it grow)
           self.recent_len = Self::MAX_CANOPY as u8;
       }
   }
   ```

2. **Or add validation in init/load** to ensure `recent_len <= MAX_CANOPY` when tree is loaded

3. **Consider making recent_len a constant** if it's always `MAX_CANOPY` after the first overflow (though this would require refactoring)

## Related Code

- `programs/pool/src/lib.rs:3593` - `recent_len` field definition
- `programs/pool/src/lib.rs:3599` - `MAX_CANOPY` constant
- `programs/pool/src/lib.rs:3780` - `recent_len` initialization
- `programs/pool/src/lib.rs:3986` - `record_recent` function

