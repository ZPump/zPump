# Roots Length Cast Overflow

## Severity: MEDIUM

## Description

The `roots_len` field is `u8` (0-255), but it's cast to `usize` when used as an array index. If `roots_len` exceeds the actual array size (64), the code will panic or access out of bounds.

## Vulnerability Details

### Current Implementation

```3669:3670:programs/pool/src/lib.rs
for idx in 0..self.roots_len as usize {
```

The `roots_len` is `u8`, but `MAX_ROOTS` is 64. If `roots_len` somehow exceeds 64 (shouldn't happen, but defense in depth), the cast to `usize` could cause out-of-bounds access.

### Potential Vulnerabilities

1. **Out of Bounds Access**: If `roots_len > 64`, accessing `self.recent_roots[idx]` will panic or access invalid memory.

2. **State Corruption**: If `roots_len` is corrupted and exceeds array bounds, the code will fail.

3. **No Bounds Check**: The code doesn't validate that `roots_len <= MAX_ROOTS` before using it as an index.

## Exploitation Scenario

```rust
// Scenario: Corrupted roots_len
// 1. Account data is corrupted
// 2. roots_len is set to 100 (exceeds MAX_ROOTS = 64)
// 3. Code casts roots_len (100) to usize
// 4. Loop tries to access recent_roots[100]
// 5. Out of bounds access, panic or undefined behavior
```

## Code References

- Line 3669: `self.roots_len as usize` in `is_known_root`
- Line 3656: `self.roots_len += 1` in `push_root`
- MAX_ROOTS constant: Line 3626

## Mitigation

1. **Validate roots_len before use**:
```rust
pub fn is_known_root(&self, candidate: &[u8; 32]) -> bool {
    let clock = Clock::get().ok();
    let current_time = clock.map(|c| c.unix_timestamp).unwrap_or(0);
    
    if &self.current_root == candidate {
        return true;
    }
    
    // CRITICAL FIX: Validate roots_len doesn't exceed array bounds
    let roots_len = self.roots_len.min(Self::MAX_ROOTS as u8) as usize;
    for idx in 0..roots_len {
        let root = &self.recent_roots[idx];
        let root_timestamp = self.recent_roots_timestamps[idx];
        
        // Check expiration
        if current_time > root_timestamp + Self::ROOT_EXPIRATION_SECONDS {
            continue; // Root expired, skip
        }
        
        if root == candidate {
            return true;
        }
    }
    false
}
```

2. **Validate in push_root**:
```rust
pub fn push_root(&mut self, root: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;
    let timestamp = clock.unix_timestamp;
    
    // CRITICAL FIX: Validate roots_len doesn't exceed MAX_ROOTS
    require!(
        self.roots_len as usize <= Self::MAX_ROOTS,
        PoolError::RootsOverflow
    );
    
    if self.roots_len as usize >= Self::MAX_ROOTS {
        // ... existing overflow handling ...
    } else {
        // ... existing logic ...
    }
    Ok(())
}
```

3. **Add error type**:
```rust
#[error_code]
pub enum PoolError {
    // ... existing errors ...
    #[msg("Roots length exceeds maximum")]
    RootsOverflow,
}
```

4. **Add integrity check**:
```rust
pub fn validate_roots_integrity(&self) -> Result<()> {
    require!(
        self.roots_len as usize <= Self::MAX_ROOTS,
        PoolError::RootsOverflow
    );
    require!(
        self.roots_len as usize <= self.recent_roots.len(),
        PoolError::RootsOverflow
    );
    Ok(())
}
```

## Additional Considerations

- `roots_len` is `u8`, so max value is 255, but array size is 64
- The mismatch between u8 max (255) and array size (64) should be validated
- Consider changing `roots_len` to `u8` with max value check, or use `usize` if needed

