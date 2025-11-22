# Verifying Key Size DoS Attack

## Severity: MEDIUM

## Description

The factory program allows creation of verifying keys with a maximum size of 100KB. While there's a size limit, large keys could still cause DoS through excessive compute consumption or account space requirements.

## Vulnerability Details

### Current Implementation

Verifying key creation includes:
- Size limit: `MAX_VERIFYING_KEY_SIZE = 100KB` (line 334)
- Hash validation: Verifies key hash matches provided hash
- Authority restriction: Only factory can create keys

### Potential Vulnerabilities

1. **Account Space Exhaustion**: Large verifying keys consume significant account space. If many keys are created, rent requirements could be high.

2. **Compute Consumption**: Loading and validating large keys consumes compute units. Multiple operations with large keys could exhaust compute budgets.

3. **Memory Usage**: Large keys consume memory during verification, potentially causing issues.

4. **Key Proliferation**: If many large keys are created, total space consumption could be significant.

5. **Verification Cost**: Verifying proofs with large keys is more expensive, potentially causing DoS.

6. **Key Replacement**: Replacing keys requires creating new accounts, which could be expensive.

## Exploitation Scenario

```rust
// Scenario 1: Account space exhaustion
// 1. Attacker (with factory authority) creates many large verifying keys
// 2. Each key consumes 100KB of account space
// 3. Rent requirements become very high
// 4. System becomes expensive to operate

// Scenario 2: Compute exhaustion
// 1. Attacker creates large verifying keys
// 2. Operations that load keys consume excessive compute
// 3. Transactions start failing due to compute limits
// 4. System becomes unusable

// Scenario 3: Key proliferation
// 1. Attacker creates many keys (even if size-limited)
// 2. Total space consumption grows unbounded
// 3. System resources are exhausted
// 4. DoS attack succeeds
```

## Code References

- Size limit: `MAX_VERIFYING_KEY_SIZE = 100KB` (line 334)
- Key creation: `create_verifying_key` (lines 338-403)
- Hash validation: Lines 359-366

## Mitigation

1. **Reduce Size Limit**: Consider reducing maximum key size (e.g., to 50KB) if feasible.

2. **Key Count Limits**: Implement a maximum number of verifying keys per circuit.

3. **Key Expiration**: Implement expiration for old keys to allow cleanup.

4. **Key Versioning**: Use versioning to deprecate old keys and limit active keys.

5. **Compute Budget Monitoring**: Monitor compute usage for key operations and set limits.

6. **Key Cleanup Mechanism**: Implement mechanism to remove unused keys.

7. **Size-Based Fees**: Consider charging fees based on key size to discourage large keys.

8. **Key Compression**: If possible, compress keys to reduce size.

## Recommended Code Changes

```rust
// Reduced size limit
pub const MAX_VERIFYING_KEY_SIZE: usize = 50 * 1024; // 50KB instead of 100KB

// Key count limit
pub struct FactoryState {
    // ... existing fields ...
    pub verifying_key_count: u32, // Track number of keys
}

pub const MAX_VERIFYING_KEYS_PER_CIRCUIT: u32 = 10; // Max 10 keys per circuit

pub fn create_verifying_key(
    ctx: Context<CreateVerifyingKey>,
    circuit_tag: [u8; 32],
    // ... args ...
) -> Result<()> {
    // ... existing validation ...
    
    // Check key count limit
    let state = &mut ctx.accounts.factory_state;
    // Count keys for this circuit (would need to track this)
    // For now, just check total size of all keys
    
    // Validate size
    require!(
        verifying_key_data.len() <= ptf_factory::MAX_VERIFYING_KEY_SIZE,
        FactoryError::VerifyingKeyTooLarge
    );
    
    // Additional validation: ensure key is reasonable
    const MIN_VERIFYING_KEY_SIZE: usize = 100; // Minimum reasonable size
    require!(
        verifying_key_data.len() >= MIN_VERIFYING_KEY_SIZE,
        FactoryError::VerifyingKeyTooSmall
    );
    
    // ... rest of creation ...
}
```

