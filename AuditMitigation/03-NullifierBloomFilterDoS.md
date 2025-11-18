# Mitigation: Nullifier Set Bloom Filter False Positives

## Severity: CRITICAL
## Contract: ptf_pool
## Issue ID: 3

## Problem Description

The nullifier set uses a bloom filter which can have false positives - incorrectly reporting a nullifier as used when it's not. This causes permanent DoS for affected users.

## Security Impact

1. **Permanent DoS:** Users whose nullifiers trigger false positives cannot spend their notes
2. **No Recovery:** Once a false positive occurs, there's no way to recover
3. **Unfair:** Legitimate users are blocked while attackers could still exploit the system

## Mitigation Strategies

### Option 1: Replace with Deterministic Set (RECOMMENDED)
**Complexity:** High  
**Time:** 2-3 weeks

Replace bloom filter with a deterministic data structure:
- **Hash Set:** Store nullifiers in a hash set (requires more storage)
- **Merkle Tree:** Use Merkle tree for nullifiers (more complex but scalable)
- **Sorted Array:** Keep sorted array of nullifiers (simple but O(n) lookup)

**Implementation:**
```rust
// Replace NullifierSet with deterministic structure
#[account]
pub struct NullifierSet {
    pub pool: Pubkey,
    pub nullifiers: Vec<[u8; 32]>, // Or use more efficient structure
    pub bump: u8,
}

impl NullifierSet {
    pub fn insert(&mut self, nullifier: [u8; 32]) -> Result<()> {
        // Binary search to find insertion point
        match self.nullifiers.binary_search(&nullifier) {
            Ok(_) => err!(PoolError::NullifierReuse),
            Err(pos) => {
                self.nullifiers.insert(pos, nullifier);
                Ok(())
            }
        }
    }
    
    pub fn contains(&self, nullifier: &[u8; 32]) -> bool {
        self.nullifiers.binary_search(nullifier).is_ok()
    }
}
```

**Pros:**
- No false positives
- Deterministic behavior
- Users can always spend their notes

**Cons:**
- Requires more storage (grows with number of nullifiers)
- O(log n) lookup time
- Account size limits may be an issue

### Option 2: Hybrid Approach
**Complexity:** Medium  
**Time:** 1-2 weeks

Use bloom filter for fast rejection, but add a confirmation set for potential positives:

```rust
pub struct NullifierSet {
    pub bloom: [u8; 512], // Fast rejection
    pub confirmed: Vec<[u8; 32]>, // Confirmation set
    // ...
}

pub fn insert(&mut self, nullifier: [u8; 32]) -> Result<()> {
    // Check confirmed set first (deterministic)
    if self.confirmed.contains(&nullifier) {
        return err!(PoolError::NullifierReuse);
    }
    
    // Check bloom filter
    if self.test_bloom_bits(&nullifier) {
        // Potential positive - add to confirmed set
        self.confirmed.push(nullifier);
        return err!(PoolError::NullifierReuse);
    }
    
    // Not in bloom - definitely not used
    self.set_bloom_bits(&nullifier);
    Ok(())
}
```

**Pros:**
- Fast for common case (bloom filter)
- No false positives (confirmed set)
- Backward compatible

**Cons:**
- More complex
- Confirmed set still grows
- Two data structures to maintain

### Option 3: Increase Bloom Filter Size
**Complexity:** Low  
**Time:** 1 week

Increase bloom filter size to reduce false positive rate:

```rust
pub const BLOOM_BYTES: usize = 2048; // Increase from 512
```

**Pros:**
- Simple change
- Reduces false positive rate
- Backward compatible (can migrate)

**Cons:**
- Doesn't eliminate false positives
- Still has DoS risk
- Temporary solution only

## Recommended Approach

**Immediate:** Implement Option 3 to reduce false positive rate
**Short-term:** Design and implement Option 1 (deterministic set)
**Long-term:** Migrate to deterministic set

## Code Changes

### Immediate (Option 3)
```rust
// Increase bloom filter size
pub const BLOOM_BYTES: usize = 2048; // 4x increase
pub const SPACE: usize = 8 + core::mem::size_of::<NullifierSet>() + 64;
```

### Long-term (Option 1)
Replace entire NullifierSet implementation with deterministic structure.

## Testing

1. Test false positive rate with current bloom filter
2. Test deterministic set with large number of nullifiers
3. Test migration from bloom to deterministic
4. Performance testing for lookup times

## Migration Plan

1. Deploy increased bloom filter size (Option 3)
2. Design deterministic structure
3. Deploy deterministic structure to new pools
4. Migrate existing pools gradually
5. Deprecate bloom filter

## Risk Assessment

**Current Risk:** CRITICAL - Users can be permanently DoS'd

**After Immediate Fix:** HIGH - Reduced but still present

**After Long-term Fix:** LOW - No false positives possible

## References

- Issue location: `programs/pool/src/lib.rs:3037-3094`
- Related struct: `NullifierSet`
- Related function: `insert()`

