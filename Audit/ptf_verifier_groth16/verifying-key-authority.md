# Verifying Key Authority and Validation

## Severity: CRITICAL

## Description

The verifier program stores verifying keys that are used to validate Groth16 proofs. If verifying keys can be manipulated or unauthorized keys can be registered, attackers could create malicious keys that accept invalid proofs, completely compromising the system.

## Vulnerability Details

### Current Implementation

The code includes:
- Authority restriction: Only factory program can create keys (lines 68-92)
- Factory PDA validation: Ensures authority is specifically the factory_state PDA
- Hash verification: Verifies key hash matches provided hash
- Version validation: Checks minimum supported version

### Potential Vulnerabilities

1. **Factory Compromise**: If the factory program or its authority is compromised, malicious keys could be registered.

2. **Key Hash Mismatch**: If hash verification is bypassed or incorrect, malicious keys could be registered.

3. **Key Version Manipulation**: If version checks are insufficient, old or insecure keys could be used.

4. **Key Size DoS**: Large verifying keys could cause DoS or consume excessive resources.

5. **Key Replacement**: If keys can be replaced without proper safeguards, legitimate keys could be replaced with malicious ones.

6. **Key Authority Bypass**: If the authority check is not strict enough, unauthorized parties could register keys.

## Exploitation Scenario

```rust
// Scenario 1: Factory compromise
// 1. Factory authority is compromised
// 2. Attacker creates malicious verifying key that accepts all proofs
// 3. Attacker uses fake proofs to drain pools
// 4. Entire system is compromised

// Scenario 2: Hash bypass
// 1. Attacker finds way to bypass hash verification
// 2. Attacker registers key with incorrect hash
// 3. Key validation might fail or behave unexpectedly
// 4. System security is compromised

// Scenario 3: Key replacement
// 1. Legitimate key is registered and in use
// 2. Attacker compromises factory
// 3. Attacker replaces legitimate key with malicious key
// 4. All pools using the key become vulnerable
```

## Code References

- Key creation: `initialize_verifying_key` (lines 34-115)
- Authority validation: Lines 68-92
- Hash verification: Lines 94-97, 280-285
- Version check: Lines 62-66, 143-146
- Size limit: `MAX_VERIFYING_KEY_SIZE` (line 334)

## Mitigation

1. **Multi-Signature for Key Creation**: Require multi-signature approval for verifying key creation, not just factory authority.

2. **Key Registration Timelock**: Implement a timelock for key registration, allowing time to detect and prevent malicious keys.

3. **Key Rotation Policy**: Implement a secure key rotation mechanism that requires old keys to be explicitly deprecated before new keys are activated.

4. **Key Hash Verification**: Strengthen hash verification by using multiple hash functions or additional validation.

5. **Key Size Limits**: The code already has `MAX_VERIFYING_KEY_SIZE` (100KB), which is good. Ensure this is strictly enforced.

6. **Key Versioning**: Implement a more sophisticated versioning system that tracks key versions and deprecates old versions.

7. **Key Audit Trail**: Maintain a complete audit trail of all key registrations, modifications, and usage.

8. **Key Validation on Use**: When verifying proofs, validate that the verifying key is still authorized and hasn't been revoked.

9. **Emergency Key Revocation**: Implement an emergency mechanism to revoke compromised keys quickly.

10. **Key Registry**: Maintain a registry of all authorized keys with their status (active, deprecated, revoked).

## Recommended Code Changes

```rust
// Enhanced key registration with timelock
pub struct VerifyingKeyRegistration {
    pub key_account: Pubkey,
    pub proposed_key_data: Vec<u8>,
    pub proposed_hash: [u8; 32],
    pub proposed_at: i64,
    pub activate_after: i64, // Timelock
    pub approved_by: Vec<Pubkey>, // Multi-sig approvals
    pub status: KeyRegistrationStatus,
}

pub enum KeyRegistrationStatus {
    Pending,
    Approved,
    Active,
    Revoked,
}

// Multi-sig key creation
pub fn propose_verifying_key(
    ctx: Context<ProposeVerifyingKey>,
    // ... args ...
) -> Result<()> {
    // Require factory authority or multi-sig
    require_authority_or_multisig(&ctx, &ctx.accounts.factory_state)?;
    
    // Create registration with timelock
    let clock = Clock::get()?;
    let registration = &mut ctx.accounts.registration;
    registration.proposed_key_data = verifying_key_data.clone();
    registration.proposed_hash = hash;
    registration.proposed_at = clock.unix_timestamp;
    registration.activate_after = clock.unix_timestamp + 7 * 24 * 60 * 60; // 7 days
    registration.status = KeyRegistrationStatus::Pending;
    
    Ok(())
}

// Activate key after timelock
pub fn activate_verifying_key(
    ctx: Context<ActivateVerifyingKey>,
) -> Result<()> {
    let registration = &ctx.accounts.registration;
    let clock = Clock::get()?;
    
    require!(
        clock.unix_timestamp >= registration.activate_after,
        VerifierError::TimelockNotReady
    );
    
    require!(
        registration.status == KeyRegistrationStatus::Approved,
        VerifierError::KeyNotApproved
    );
    
    // Verify hash again before activation
    let mut hasher = Keccak256::new();
    hasher.update(&registration.proposed_key_data);
    let computed_hash: [u8; 32] = hasher.finalize().into();
    require!(
        computed_hash == registration.proposed_hash,
        VerifierError::HashMismatch
    );
    
    // Initialize the actual key account
    // ... initialize key ...
    
    registration.status = KeyRegistrationStatus::Active;
    Ok(())
}

// Key revocation
pub fn revoke_verifying_key(
    ctx: Context<RevokeVerifyingKey>,
) -> Result<()> {
    // Require multi-sig or emergency authority
    require_authority_or_emergency(&ctx)?;
    
    let vk = &mut ctx.accounts.verifier_state;
    vk.revoked = true;
    vk.revoked_at = Some(Clock::get()?.unix_timestamp);
    
    Ok(())
}

// Enhanced verification with key status check
pub fn verify_groth16(
    ctx: Context<VerifyGroth16>,
    // ... args ...
) -> Result<()> {
    let vk = &ctx.accounts.verifier_state;
    
    // Check if key is revoked
    require!(!vk.revoked, VerifierError::KeyRevoked);
    
    // Check version
    require!(
        vk.version >= MIN_SUPPORTED_VERSION,
        VerifierError::VersionTooOld
    );
    
    // Verify hash integrity
    require!(verify_account_hash(vk), VerifierError::HashMismatch);
    
    // ... rest of verification ...
}
```

