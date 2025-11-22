# No Verifying Key Update or Revocation Mechanism

## Severity: HIGH

## Description

Once a verifying key is registered, there is no mechanism to update or revoke it. If a key is compromised, contains bugs, or needs to be replaced due to circuit upgrades, the system cannot respond, potentially leaving the system vulnerable or broken.

## Vulnerability Details

### Current Implementation

- Keys are registered with `init` constraint, meaning they can only be created once
- No update instruction exists
- No revocation mechanism exists
- Keys are immutable once created

### Potential Vulnerabilities

1. **Compromised Key Immutability**: If a verifying key is compromised (e.g., factory is hacked), there's no way to revoke it and prevent its use.

2. **Circuit Upgrade Inability**: If a circuit is upgraded and needs a new verifying key, the old key cannot be replaced - a new key must be registered with a different `circuit_tag` or `version`, but the old key remains active.

3. **Bug Fixes**: If a verifying key contains bugs or is found to be incorrect, it cannot be fixed.

4. **Key Rotation**: There's no mechanism for key rotation, which is a security best practice.

5. **Emergency Response**: In case of emergency (e.g., critical vulnerability), there's no way to quickly disable compromised keys.

## Exploitation Scenario

```rust
// Scenario 1: Compromised factory
// 1. Factory authority is compromised
// 2. Attacker registers malicious verifying key
// 3. Key accepts invalid proofs
// 4. System is compromised
// 5. No way to revoke the malicious key
// 6. System remains vulnerable

// Scenario 2: Circuit upgrade
// 1. Circuit is upgraded with security improvements
// 2. New verifying key is needed
// 3. Old key cannot be replaced
// 4. Both old and new keys exist
// 5. Users might accidentally use old insecure key
// 6. System security is degraded

// Scenario 3: Key bug discovery
// 1. Bug is discovered in verifying key
// 2. Key produces incorrect verification results
// 3. Key cannot be updated or fixed
// 4. System behavior is incorrect
// 5. No remediation possible
```

## Code References

- Key initialization: `initialize_verifying_key` (lines 34-115)
- Account constraint: `init` (line 188) - prevents reinitialization
- No update or revocation instructions exist

## Mitigation

1. **Add Key Update Instruction**: Allow authorized parties to update verifying keys:

```rust
pub fn update_verifying_key(
    ctx: Context<UpdateVerifyingKey>,
    new_hash: [u8; 32],
    new_version: u8,
    new_verifying_key_data: Vec<u8>,
) -> Result<()> {
    // Require factory authority
    let vk = &mut ctx.accounts.verifier_state;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        vk.authority,
        VerifierError::UnauthorizedAuthority
    );
    
    // Validate new key data
    require!(!new_verifying_key_data.is_empty(), VerifierError::EmptyVerifyingKey);
    require!(new_version >= MIN_SUPPORTED_VERSION, VerifierError::VersionTooOld);
    
    // Verify hash
    let mut hasher = Keccak256::new();
    hasher.update(&new_verifying_key_data);
    let computed_hash: [u8; 32] = hasher.finalize().into();
    require!(computed_hash == new_hash, VerifierError::HashMismatch);
    
    // Update key
    vk.hash = new_hash;
    vk.version = new_version;
    vk.verifying_key = new_verifying_key_data;
    
    emit!(VerifyingKeyUpdated {
        verifying_key_id: vk.verifying_key_id,
        new_hash,
        new_version,
    });
    
    Ok(())
}
```

2. **Add Key Revocation Mechanism**: Allow keys to be revoked:

```rust
#[account]
pub struct VerifyingKeyAccount {
    // ... existing fields ...
    pub revoked: bool,
    pub revoked_at: Option<i64>,
}

pub fn revoke_verifying_key(
    ctx: Context<RevokeVerifyingKey>,
) -> Result<()> {
    // Require factory authority or emergency authority
    let vk = &mut ctx.accounts.verifier_state;
    require_keys_eq!(
        ctx.accounts.authority.key(),
        vk.authority,
        VerifierError::UnauthorizedAuthority
    );
    
    let clock = Clock::get()?;
    vk.revoked = true;
    vk.revoked_at = Some(clock.unix_timestamp);
    
    emit!(VerifyingKeyRevoked {
        verifying_key_id: vk.verifying_key_id,
        revoked_at: clock.unix_timestamp,
    });
    
    Ok(())
}

// In verify_groth16, check revocation:
pub fn verify_groth16(
    // ... params ...
) -> Result<()> {
    let vk = &ctx.accounts.verifier_state;
    
    require!(!vk.revoked, VerifierError::KeyRevoked);
    
    // ... rest of verification ...
}
```

3. **Key Versioning**: Implement proper versioning to support key updates while maintaining backward compatibility if needed.

4. **Timelock for Updates**: Consider adding a timelock for key updates to prevent immediate malicious changes.

5. **Multi-Signature**: Require multi-signature approval for key updates/revocations.

6. **Emergency Authority**: Implement an emergency authority that can quickly revoke keys in case of compromise.

7. **Add Error Types**: Add error variants for revoked keys:

```rust
#[error_code]
pub enum VerifierError {
    // ... existing errors ...
    #[msg("verifying key has been revoked")]
    KeyRevoked,
}
```

