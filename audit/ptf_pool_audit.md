# Security Audit Report: ptf_pool

**Program ID:** `7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh`  
**Audit Date:** 2025-11-16  
**Severity Grade:** **F (Critical)**

## Executive Summary

The `ptf_pool` program contains **multiple critical vulnerabilities** that compromise the security and functionality of the privacy pool system:

1. **Nullifier capacity exhaustion** - Pools become permanently unusable after 256 spends
2. **Mint status not enforced** - Frozen mints can still be used for all operations
3. **Shield finalization optional** - Griefing attacks can stall deposits
4. **Dependency on vulnerable verifier** - Relies on broken proof verification (see `ptf_verifier_groth16_audit.md`)
5. **Dependency on vulnerable vault** - Relies on broken vault authorization (see `ptf_vault_audit.md`)

## Critical Issues

### CRITICAL-001: Nullifier Storage Capacity Exhaustion

**Severity:** Critical  
**Location:** `programs/pool/src/lib.rs:2472, 2481-2482`

**Description:**
The `NullifierSet` has a fixed capacity of 256 entries. Once this capacity is reached, all future shield/unshield operations fail permanently:

```rust
pub const MAX_NULLIFIERS: usize = 256;

pub fn insert(&mut self, value: [u8; 32]) -> Result<()> {
    if self.contains(&value) {
        return err!(PoolError::NullifierReuse);
    }
    require!(
        (self.count as usize) < Self::MAX_NULLIFIERS,
        PoolError::NullifierCapacity,
    );
    // ... insert logic
}
```

**Vulnerability:**
- After 256 nullifiers are recorded, `count == 256`
- All subsequent `insert()` calls fail with `PoolError::NullifierCapacity`
- This affects ALL operations that spend notes (unshield, transfer)
- There is **no rotation, pruning, or migration path**
- The pool becomes permanently bricked

**Attack Scenario:**
1. Attacker creates 256 small dust transactions (e.g., 1 lamport each)
2. Each transaction spends a note, adding a nullifier
3. After 256 transactions, `NullifierSet::count == 256`
4. All future legitimate users cannot unshield or transfer
5. The pool is permanently unusable
6. All funds in the pool are effectively locked forever

**Impact:**
- **Permanent DoS attack** - Pool becomes unusable after 256 spends
- **Fund lockup** - All deposited funds become inaccessible
- **Trivial to exploit** - Requires only 256 small transactions
- **No recovery mechanism** - Cannot be fixed without program upgrade
- **Affects all pools** - Every pool has this limitation

**Recommended Fix:**
Implement a paged or rolling nullifier structure:

**Option 1: Bloom Filter Only (Recommended for Solana)**
```rust
pub struct NullifierSet {
    pub pool: Pubkey,
    pub bloom: [u8; NullifierSet::BLOOM_BYTES], // 512 bytes = 4096 bits
    pub bump: u8,
}

impl NullifierSet {
    pub const BLOOM_BYTES: usize = 512;
    
    pub fn insert(&mut self, value: [u8; 32]) -> Result<()> {
        if self.contains(&value) {
            return err!(PoolError::NullifierReuse);
        }
        // Bloom filter has no capacity limit (only false positive rate)
        self.set_bloom_bits(&value);
        Ok(())
    }
    
    pub fn contains(&self, value: &[u8; 32]) -> bool {
        self.test_bloom_bits(value)
    }
}
```

**Option 2: Paged Structure**
```rust
pub struct NullifierSet {
    pub pool: Pubkey,
    pub current_page: u32,
    pub pages: [NullifierPage; MAX_PAGES],
    pub bump: u8,
}

pub struct NullifierPage {
    pub entries: [[u8; 32]; 256],
    pub count: u32,
    pub bloom: [u8; 64],
}

// When a page fills, move to next page and clear old entries
```

**Option 3: Time-based Expiration**
```rust
pub struct NullifierEntry {
    pub nullifier: [u8; 32],
    pub timestamp: i64, // When it was added
}

// Periodically prune entries older than X days
// Requires additional instruction for maintenance
```

**Immediate Workaround:**
- Increase `MAX_NULLIFIERS` to a larger value (e.g., 65536) as a temporary measure
- This delays the attack but doesn't solve it
- Still requires a proper fix for long-term security

### CRITICAL-002: Mint Status Not Enforced

**Severity:** Critical  
**Location:** `programs/pool/src/lib.rs` (shield, transfer, unshield functions)

**Description:**
The pool program **never checks** the `mint_mapping.status` field before processing transactions. The factory program can freeze mints (set `status = MintStatus::Frozen`), but the pool program ignores this status.

**Vulnerability:**
- `shield()` function (line 223) - No mint status check
- `transfer()` function (line 680) - No mint status check  
- `unshield()` function (line 850) - No mint status check
- Factory can freeze mints, but pool continues to accept transactions
- Frozen mints cannot be effectively stopped

**Attack Scenario:**
1. A mint is compromised (e.g., private key leak, smart contract bug)
2. Factory authority freezes the mint to prevent further damage
3. Attacker continues to use the pool because pool doesn't check status
4. Attacker can still shield, transfer, and unshield tokens
5. Freeze mechanism is ineffective

**Impact:**
- **Governance bypass** - Freeze mechanism doesn't work
- **Continued exploitation** - Compromised mints remain usable
- **No emergency stop** - Cannot effectively halt compromised pools
- **Regulatory compliance** - Cannot enforce sanctions or freezes

**Recommended Fix:**
Add mint status checks to all entry points:

```rust
// In shield(), transfer(), and unshield() functions
let mint_mapping = ctx.accounts.mint_mapping.load()?;
require!(
    mint_mapping.status == ptf_factory::MintStatus::Active as u8,
    PoolError::MintFrozen,
);

// Add to PoolError enum
#[error_code]
pub enum PoolError {
    // ... existing errors
    #[msg("E_MINT_FROZEN")]
    MintFrozen,
}
```

**Required Changes:**
1. Add `mint_mapping` account to `Shield`, `Transfer`, and `Unshield` context structs
2. Add status check at the beginning of each function
3. Add `MintFrozen` error code
4. Update all call sites to include `mint_mapping` account

### CRITICAL-003: Shield Finalization Optional

**Severity:** High  
**Location:** `programs/pool/src/lib.rs:418-436`

**Description:**
The `shield()` function searches for a `shield_finalize_ledger` instruction in the transaction. If not found, it only logs a warning and continues:

```rust
if !finalize_found {
    msg!("shield finalize instruction not detected; skipping enforcement");
}
```

**Vulnerability:**
- Shield finalization is **optional**, not required
- If finalization is missing, `pending_shield` remains active
- New shields are blocked while `pending_shield` is active
- Attacker can grief by submitting shields without finalization
- Legitimate users cannot shield until someone else finalizes

**Attack Scenario:**
1. Attacker submits a `shield` transaction without `shield_finalize_ledger`
2. Transaction succeeds, `pending_shield` is set to active
3. All subsequent `shield` calls fail with `PoolError::PendingShieldInFlight`
4. Legitimate users cannot deposit
5. Attacker can repeat this to keep the pool locked
6. Requires a benevolent actor to finalize the shield to unlock

**Impact:**
- **Griefing attack** - Can prevent legitimate deposits
- **Liveness issue** - Pool can be locked by malicious actors
- **No enforcement** - Finalization is optional, not required
- **User experience** - Legitimate users blocked by attacker

**Recommended Fix:**
Make finalization mandatory:

```rust
// In shield() function, replace the warning with an error
if !finalize_found {
    return err!(PoolError::ShieldFinalizationRequired);
}

// Add to PoolError enum
#[error_code]
pub enum PoolError {
    // ... existing errors
    #[msg("E_SHIELD_FINALIZATION_REQUIRED")]
    ShieldFinalizationRequired,
}
```

**Alternative Fix:**
If finalization must be optional for some reason:
- Add a timeout mechanism - automatically finalize after N slots
- Add a separate instruction to clear stuck pending shields (with authority check)
- Require finalization for large amounts only

### HIGH-001: Dependency on Vulnerable Verifier

**Severity:** High (inherited from `ptf_verifier_groth16`)  
**Location:** `programs/pool/src/lib.rs:349, 753, 957`

**Description:**
The pool program calls `ptf_verifier_groth16::verify_groth16` in three critical locations:
- `shield()` - Line 349
- `transfer()` - Line 753
- `unshield()` - Line 957

**Vulnerability:**
The verifier program has a critical bug where it always returns `true` on-chain (see `ptf_verifier_groth16_audit.md`). This means:
- All proofs are accepted regardless of validity
- Zero-knowledge security is completely compromised
- Double-spending is possible
- Unauthorized withdrawals are possible

**Impact:**
- Inherits all vulnerabilities from the verifier program
- Complete compromise of privacy pool security
- All three operations (shield, transfer, unshield) are vulnerable

**Recommended Fix:**
1. Fix the verifier program first (see `ptf_verifier_groth16_audit.md`)
2. Add integration tests that verify invalid proofs are rejected
3. Consider adding additional validation layers in the pool program

### HIGH-002: Dependency on Vulnerable Vault

**Severity:** High (inherited from `ptf_vault`)  
**Location:** `programs/pool/src/lib.rs:1060`

**Description:**
The pool program calls `ptf_vault::release` during unshield operations (line 1060).

**Vulnerability:**
The vault program has a critical bug where `release` doesn't verify the caller is a signer (see `ptf_vault_audit.md`). However, the pool program correctly uses `invoke_signed` with PDA seeds, so this specific call path is secure. But if the vault is called directly by an attacker, funds can be drained.

**Impact:**
- The pool's own calls are secure (uses PDA signing)
- But vault can still be drained by direct calls
- All vault funds are at risk

**Recommended Fix:**
1. Fix the vault program first (see `ptf_vault_audit.md`)
2. The pool program's usage is correct, but the underlying dependency must be fixed

## Additional Security Observations

### OBS-001: Root Validation

**Location:** Multiple locations

The pool program correctly validates commitment tree roots before processing transactions. This is good.

### OBS-002: Nullifier Reuse Prevention

**Location:** `programs/pool/src/lib.rs:763-771, 984-992`

The pool program correctly prevents nullifier reuse using the `NullifierSet`. However, this is limited by the capacity issue (CRITICAL-001).

### OBS-003: Fee Calculation

**Location:** Multiple locations

Fee calculations appear correct and use `checked_add` to prevent overflow. Good practice.

### OBS-004: Account Validation

**Location:** Throughout

The pool program performs extensive account validation (mint matching, vault validation, etc.). This is good practice.

## Recommendations

### Immediate (Before Any Deployment)

1. **CRITICAL:** Fix CRITICAL-001 (Nullifier capacity) - Implement bloom filter or paged structure
2. **CRITICAL:** Fix CRITICAL-002 (Mint status) - Add status checks to all entry points
3. **HIGH:** Fix CRITICAL-003 (Shield finalization) - Make finalization mandatory
4. **HIGH:** Fix dependencies - Address verifier and vault vulnerabilities first

### High Priority

1. Add comprehensive integration tests for all critical paths
2. Add tests that verify frozen mints are rejected
3. Add tests that verify nullifier capacity handling
4. Add tests that verify shield finalization is required

### Medium Priority

1. Consider adding a pause mechanism for emergency stops
2. Add monitoring/logging for security events
3. Consider adding rate limiting for griefing protection
4. Document all security assumptions and dependencies

### Low Priority

1. Code review for additional edge cases
2. Performance optimization (if needed)
3. Gas optimization (if needed)

## Testing Recommendations

1. **Nullifier Capacity Test:**
   - Create 256 transactions that each spend a note
   - Verify 257th transaction fails with `NullifierCapacity`
   - Verify pool is unusable after capacity exhaustion

2. **Mint Status Test:**
   - Freeze a mint via factory
   - Attempt to shield/transfer/unshield - should fail
   - Currently this test will fail (mint status not checked)

3. **Shield Finalization Test:**
   - Submit shield without finalization - should fail
   - Currently this test will fail (finalization optional)

4. **Proof Verification Test:**
   - Submit invalid proof - should fail
   - Currently this test will fail (verifier always returns true)

5. **Integration Tests:**
   - Test full shield -> transfer -> unshield flow
   - Test with frozen mint (should fail)
   - Test with nullifier capacity exhausted (should fail)

## Conclusion

The `ptf_pool` program has **multiple critical vulnerabilities** that must be addressed before production deployment:

1. **Nullifier capacity exhaustion** makes pools permanently unusable after 256 spends
2. **Mint status not enforced** makes freeze mechanism ineffective
3. **Shield finalization optional** allows griefing attacks
4. **Dependencies on vulnerable programs** (verifier and vault) compound the issues

All of these issues are fixable, but require careful implementation and thorough testing. The program should **NOT** be deployed to mainnet until all critical issues are resolved.

