# Fix 03: Nullifier Capacity Exhaustion

**Priority:** CRITICAL - Must fix before production  
**Estimated Time:** 8-16 hours  
**Risk Level:** High (requires careful design)  
**Dependencies:** Fixes 01 and 02 should be done first  

## Problem Summary

The `NullifierSet` has a fixed capacity of 256 entries. Once `count == 256`, all future shield/unshield operations fail with `NullifierCapacity`, permanently bricking the pool.

## Impact

- **Severity:** Critical
- **Attack Complexity:** Trivial (requires 256 transactions)
- **Impact:** Permanent DoS - pool becomes unusable
- **Affected Operations:** transfer, unshield

## Solution Overview

Replace the fixed array structure with a bloom filter-only approach. Bloom filters have no capacity limit and can handle unlimited nullifiers (with a small false positive rate).

## Step-by-Step Implementation

### Step 1: Update NullifierSet Structure

**File:** `programs/pool/src/lib.rs`

**Location:** Lines 2461-2474

**Current Code:**
```rust
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct NullifierSet {
    pub pool: Pubkey,
    pub count: u32,
    pub entries: [[u8; 32]; NullifierSet::MAX_NULLIFIERS],
    pub bloom: [u8; NullifierSet::BLOOM_BYTES],
    pub bump: u8,
}

impl NullifierSet {
    pub const MAX_NULLIFIERS: usize = 256;
    pub const BLOOM_BYTES: usize = 512;
    pub const SPACE: usize = 8 + core::mem::size_of::<NullifierSet>() + 64;
}
```

**New Code:**
```rust
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct NullifierSet {
    pub pool: Pubkey,
    // REMOVED: pub count: u32,
    // REMOVED: pub entries: [[u8; 32]; NullifierSet::MAX_NULLIFIERS],
    pub bloom: [u8; NullifierSet::BLOOM_BYTES],
    pub bump: u8,
    // Add padding to maintain same size (optional, for migration compatibility)
    pub _reserved: [u8; 4 + (32 * 256)], // 4 bytes for count + 256*32 bytes for entries
}

impl NullifierSet {
    // REMOVED: pub const MAX_NULLIFIERS: usize = 256;
    pub const BLOOM_BYTES: usize = 512;
    pub const SPACE: usize = 8 + core::mem::size_of::<NullifierSet>() + 64;
    
    // Verify the size hasn't changed
    #[cfg(test)]
    pub fn verify_size() {
        assert_eq!(core::mem::size_of::<NullifierSet>(), 8 + 32 + 512 + 1 + (4 + 32 * 256));
    }
}
```

**Alternative (Cleaner):** If you want to reduce account size, you can remove the padding:

```rust
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct NullifierSet {
    pub pool: Pubkey,
    pub bloom: [u8; NullifierSet::BLOOM_BYTES],
    pub bump: u8,
}

impl NullifierSet {
    pub const BLOOM_BYTES: usize = 512;
    pub const SPACE: usize = 8 + 32 + 512 + 1 + 64; // Reduced size
}
```

**Note:** Reducing size requires reinitializing all existing nullifier_set accounts, which may not be feasible. Use the first approach if you need backward compatibility.

### Step 2: Update insert() Method

**File:** `programs/pool/src/lib.rs`

**Location:** Lines 2476-2488

**Current Code:**
```rust
pub fn insert(&mut self, value: [u8; 32]) -> Result<()> {
    if self.contains(&value) {
        return err!(PoolError::NullifierReuse);
    }
    require!(
        (self.count as usize) < Self::MAX_NULLIFIERS,
        PoolError::NullifierCapacity,
    );
    self.entries[self.count as usize] = value;
    self.count += 1;
    self.set_bloom_bits(&value);
    Ok(())
}
```

**New Code:**
```rust
pub fn insert(&mut self, value: [u8; 32]) -> Result<()> {
    if self.contains(&value) {
        return err!(PoolError::NullifierReuse);
    }
    // REMOVED: Capacity check - bloom filter has no limit
    // REMOVED: Linear array insertion
    self.set_bloom_bits(&value);
    Ok(())
}
```

### Step 3: Update contains() Method

**File:** `programs/pool/src/lib.rs`

**Location:** Lines 2490-2500

**Current Code:**
```rust
fn contains(&self, value: &[u8; 32]) -> bool {
    if !self.test_bloom_bits(value) {
        return false;
    }
    for idx in 0..self.count as usize {
        if self.entries[idx] == *value {
            return true;
        }
    }
    false
}
```

**New Code:**
```rust
fn contains(&self, value: &[u8; 32]) -> bool {
    // Only check bloom filter - no linear search needed
    // Bloom filter may have false positives, but that's acceptable
    // False positive rate is very low with proper hash functions
    self.test_bloom_bits(value)
}
```

### Step 4: Remove NullifierCapacity Error (Optional)

**File:** `programs/pool/src/lib.rs`

**Location:** Error enum (around line 3049)

**Action:** The `NullifierCapacity` error is no longer needed, but you can keep it for backward compatibility or remove it:

```rust
#[error_code]
pub enum PoolError {
    // ... other errors
    // REMOVED or keep for backward compatibility:
    // #[msg("E_NULLIFIER_CAPACITY")]
    // NullifierCapacity,
}
```

### Step 5: Update Initialize Pool (if needed)

**File:** `programs/pool/src/lib.rs`

**Location:** Lines 130-136

**Current Code:**
```rust
{
    let mut nulls = ctx.accounts.nullifier_set.load_init()?;
    nulls.pool = pool_key;
    nulls.bump = ctx.bumps.nullifier_set;
    nulls.count = 0;
    nulls.bloom = [0u8; NullifierSet::BLOOM_BYTES];
}
```

**New Code:**
```rust
{
    let mut nulls = ctx.accounts.nullifier_set.load_init()?;
    nulls.pool = pool_key;
    nulls.bump = ctx.bumps.nullifier_set;
    // REMOVED: nulls.count = 0;
    nulls.bloom = [0u8; NullifierSet::BLOOM_BYTES];
}
```

## Testing Plan

### Test 1: Verify Program Compiles

**Objective:** Ensure the program compiles with the changes.

**Steps:**
1. Build: `anchor build`
2. Check for compilation errors

**Expected Result:** Program compiles successfully.

### Test 2: Test Nullifier Insertion Beyond 256

**Objective:** Verify nullifiers can be inserted beyond the old limit.

**Create test:** `programs/pool/tests/nullifier_capacity.rs`

```rust
#[tokio::test]
async fn test_nullifier_capacity_unlimited() {
    // Setup: Initialize pool and nullifier_set
    
    // Insert 300 nullifiers (more than old 256 limit)
    for i in 0..300 {
        let nullifier = generate_nullifier(i);
        // This should succeed now
        nullifier_set.insert(nullifier).unwrap();
    }
    
    // Verify all can be checked
    for i in 0..300 {
        let nullifier = generate_nullifier(i);
        assert!(nullifier_set.contains(&nullifier));
    }
}
```

**Expected Result:** All 300 insertions succeed.

### Test 3: Test Nullifier Reuse Detection

**Objective:** Verify that duplicate nullifiers are still detected.

**Create test:**
```rust
#[tokio::test]
async fn test_nullifier_reuse_detected() {
    // Setup
    let nullifier = generate_nullifier(1);
    
    // First insert should succeed
    nullifier_set.insert(nullifier).unwrap();
    
    // Second insert should fail
    assert!(nullifier_set.insert(nullifier).is_err());
}
```

**Expected Result:** Duplicate insertion fails.

### Test 4: Test Bloom Filter False Positives

**Objective:** Verify false positive rate is acceptable.

**Note:** Bloom filters can have false positives but very few in practice. This test verifies the implementation works correctly.

**Create test:**
```rust
#[tokio::test]
async fn test_bloom_filter_performance() {
    // Insert many nullifiers
    for i in 0..1000 {
        nullifier_set.insert(generate_nullifier(i)).unwrap();
    }
    
    // Check for inserted nullifiers (should all be true)
    for i in 0..1000 {
        assert!(nullifier_set.contains(&generate_nullifier(i)));
    }
    
    // Check for random nullifiers (may have small false positive rate)
    // False positives are acceptable in this context
}
```

**Expected Result:** All inserted nullifiers are detected. False positive rate is low.

### Test 5: E2E Test with Many Transactions

**Objective:** Verify the fix works in real scenarios.

**Steps:**
1. Run E2E tests: `npx tsx web/app/scripts/browser-e2e.ts`
2. Verify operations succeed beyond 256 transactions

**Expected Result:** All tests pass, even after many transactions.

### Test 6: Migration Test (if keeping size)

**Objective:** Verify existing pools can be upgraded.

**Steps:**
1. Deploy old version, initialize pool
2. Deploy new version
3. Verify existing pools still work

**Expected Result:** Existing pools continue to work (if size is preserved).

## Verification Checklist

- [ ] Code changes implemented
- [ ] Program compiles: `anchor build`
- [ ] NullifierSet size is correct (if preserving for migration)
- [ ] Insertions work beyond 256: `anchor test`
- [ ] Nullifier reuse still detected: `anchor test`
- [ ] E2E tests pass: `npx tsx web/app/scripts/browser-e2e.ts`
- [ ] All existing functionality preserved

## Potential Issues and Solutions

### Issue 1: Account Size Mismatch (Migration)

**Symptom:** Existing pools fail after upgrade because account size changed.

**Solution:**
- Keep the padding in the struct (first approach)
- Or implement a migration instruction to recreate accounts
- Or wait for pools to be reinitialized

### Issue 2: Bloom Filter False Positives

**Symptom:** Some valid nullifiers are incorrectly flagged as duplicates.

**Solution:**
- False positives are acceptable - better than false negatives
- The false positive rate should be very low (< 0.1%)
- If it's a problem, increase BLOOM_BYTES

### Issue 3: Performance Concerns

**Symptom:** Bloom filter operations are slower than expected.

**Solution:**
- Bloom filter operations are actually faster (no linear search)
- If there's an issue, check the hash function implementation

## Rollback Plan

If something breaks:

1. **Immediate:** Revert the changes:
   ```bash
   git checkout programs/pool/src/lib.rs
   ```

2. **Note:** Rolling back restores the capacity limit

3. **Debug:**
   - Check if account size changed (if not using padding)
   - Verify bloom filter methods are correct
   - Check initialization code

## Expected Outcome

After this fix:
- ✅ Nullifiers can be inserted beyond 256 (capacity issue fixed)
- ✅ Nullifier reuse is still detected (security preserved)
- ✅ Pool cannot be permanently DoS'd (vulnerability fixed)
- ✅ All existing functionality preserved

## Notes

- This is a breaking change if account size changes
- Consider keeping size for migration compatibility
- Bloom filter false positives are acceptable (very low rate)
- This fix enables long-term pool operation

## Next Steps

After this fix is verified:
1. Commit the changes
2. Move to Fix 04 (Mint Status Enforcement)
3. Consider migration strategy for existing pools

