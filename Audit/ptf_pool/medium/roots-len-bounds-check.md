# Roots Length Bounds Check Missing

**Severity:** MEDIUM  
**Status:** ✅ MITIGATED

**Location:** `programs/pool/src/lib.rs:4043-4070` and `4115-4117`

## Description

The `push_root` function uses `roots_len` (a `u8`) to index into `recent_roots` array without validating that `roots_len` is within bounds. While the increment is guarded by a check against `MAX_ROOTS` (64), if `roots_len` is somehow corrupted or set to a value greater than `MAX_ROOTS` but less than 255, the indexing could be out of bounds.

## Code Reference

```rust
pub fn push_root(&mut self, root: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;
    let timestamp = clock.unix_timestamp;
    
    if self.roots_len as usize >= Self::MAX_ROOTS {
        // Overflow path - shift entries
        // ...
    } else {
        // CRITICAL: No bounds check before indexing
        self.recent_roots[self.roots_len as usize] = root;
        self.recent_roots_timestamps[self.roots_len as usize] = timestamp;
        self.roots_len += 1;  // Could overflow if roots_len is already 255
        self.current_root = root;
    }
    Ok(())
}

pub fn is_known_root(&self, candidate: &[u8; 32]) -> bool {
    // ...
    for idx in 0..self.roots_len as usize {
        // CRITICAL: No bounds check - if roots_len > MAX_ROOTS, this could panic
        if &self.recent_roots[idx] == candidate {
            // ...
        }
    }
}
```

## Issue

1. **In `push_root`**: If `roots_len` is corrupted to a value > 64 but < 255, the indexing `self.recent_roots[self.roots_len as usize]` could be out of bounds, causing a panic.

2. **In `is_known_root`**: The loop `for idx in 0..self.roots_len as usize` could iterate beyond the array bounds if `roots_len` is corrupted.

3. **Increment overflow**: If `roots_len` is already at 255 (u8::MAX), then `roots_len += 1` would wrap to 0, which could cause issues.

## Impact

- Potential panic if `roots_len` is corrupted
- Out-of-bounds array access could lead to undefined behavior
- Could be exploited if state corruption is possible through other vulnerabilities

## Attack Scenario

1. Attacker finds a way to corrupt `roots_len` (e.g., through a state corruption bug)
2. Sets `roots_len` to a value > 64 (e.g., 100)
3. Calls `push_root` or `is_known_root`
4. Array indexing goes out of bounds, causing panic or undefined behavior

## Current Mitigations

- The increment is guarded by `if self.roots_len as usize >= Self::MAX_ROOTS`
- `MAX_ROOTS` is 64, which is well within `u8` range
- However, there's no explicit validation that `roots_len <= MAX_ROOTS` before indexing

## Recommendation

1. ✅ **Add explicit bounds validation** - **FIXED**
   - Added bounds check in `push_root` using `PoolError::AccountDataCorrupt`
   - Validates `roots_len <= MAX_ROOTS` before indexing

2. ✅ **Add bounds check in `is_known_root`** - **FIXED**
   - Uses `core::cmp::min` to cap `roots_len` to `MAX_ROOTS`
   - Prevents out-of-bounds access even if state is corrupted

## Mitigation Status

**Fixed in:** Commit d1cf0fd

**Changes Made:**
- `push_root`: Added bounds validation before array indexing (line ~4047)
- `is_known_root`: Added `max_len` calculation to cap iteration (line ~4116)
- Both functions now safely handle corrupted `roots_len` values

## Related Issues

- Similar to other bounds checking issues that have been fixed
- Part of defensive programming to prevent state corruption attacks

