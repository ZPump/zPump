# Authority Compromise and Unauthorized Access

## Severity: CRITICAL

## Description

The factory program has a single authority that can perform critical operations like registering mints, updating factory state, and creating verifying keys. If this authority is compromised, the entire system could be at risk.

## Vulnerability Details

### Current Implementation

The factory has:
- Single authority for most operations
- Timelock for some operations (but not all)
- Direct updates disabled (line 902-907) - all must go through timelock

### Potential Vulnerabilities

1. **Single Point of Failure**: A single authority means if the key is compromised, the attacker has full control.

2. **No Multi-Sig**: There's no multi-signature requirement for critical operations, making compromise easier.

3. **Authority Key Management**: If the authority key is stored improperly or uses weak security, it could be compromised.

4. **Timelock Bypass for Some Operations**: While timelock is required for some operations, others like `register_mint` can be done directly (though paused state provides some protection).

5. **No Authority Rotation Mechanism**: There's no built-in mechanism to rotate the authority, making it difficult to recover from a compromise.

6. **Verifying Key Creation**: The authority can create verifying keys without additional safeguards, which could allow malicious keys to be registered.

## Exploitation Scenario

```rust
// Scenario 1: Authority key compromise
// 1. Attacker gains access to authority private key
// 2. Attacker can register malicious mints
// 3. Attacker can create malicious verifying keys
// 4. Attacker can pause/unpause factory
// 5. Entire system is compromised

// Scenario 2: Insider threat
// 1. Authority is a person or organization
// 2. Insider with access to authority key performs malicious actions
// 3. No multi-sig to prevent single-person attacks

// Scenario 3: Verifying key attack
// 1. Attacker compromises authority
// 2. Attacker creates malicious verifying key
// 3. Malicious key accepts invalid proofs
// 4. Attacker can drain pools using fake proofs
```

## Code References

- Authority checks: Throughout factory program, e.g., `has_one = authority` constraints
- Direct update prevention: `ensure_direct_update_allowed` (lines 902-907)
- Verifying key creation: `create_verifying_key` (lines 338-403)
- Mint registration: `register_mint` (lines 80-152)

## Mitigation

1. **Multi-Signature Authority**: Implement a multi-signature requirement for critical operations. Require M-of-N signatures for actions like verifying key creation, factory pause, etc.

2. **Authority Rotation**: Implement a secure authority rotation mechanism with timelock and multi-sig approval.

3. **Key Management Best Practices**: 
   - Use hardware security modules (HSMs) for authority keys
   - Implement key derivation and rotation policies
   - Use secure key storage solutions

4. **Operation Classification**: Classify operations by risk level:
   - **Critical** (require multi-sig + timelock): Verifying key creation, factory pause, authority change
   - **High** (require timelock): Mint updates, feature changes
   - **Medium** (require approval): Mint registration
   - **Low** (direct): Read-only or low-risk operations

5. **Verifying Key Approval Process**: Require additional approval (multi-sig) for verifying key creation, and implement a review period before keys become active.

6. **Emergency Pause Mechanism**: Implement an emergency pause that can be triggered by multiple parties (e.g., 3-of-5 emergency signers) independent of the main authority.

7. **Authority Activity Monitoring**: Implement extensive logging and monitoring of all authority actions to detect compromise early.

8. **Time-Limited Authority**: Consider implementing time-limited authority grants that require periodic renewal.

## Recommended Code Changes

```rust
// Multi-sig authority structure
pub struct FactoryState {
    pub authority: Pubkey, // Primary authority
    pub multi_sig: Option<MultiSigConfig>, // Optional multi-sig
    pub emergency_pause_signers: Vec<Pubkey>, // Emergency pause signers
}

pub struct MultiSigConfig {
    pub signers: Vec<Pubkey>,
    pub threshold: u8, // M-of-N
}

// Enhanced authority check
fn require_authority_or_multisig(
    ctx: &Context,
    state: &FactoryState,
) -> Result<()> {
    // Check single authority
    if ctx.accounts.authority.key() == state.authority {
        return Ok(());
    }
    
    // Check multi-sig if configured
    if let Some(multi_sig) = &state.multi_sig {
        let mut signatures = 0;
        for signer in &multi_sig.signers {
            if ctx.remaining_accounts.iter().any(|acc| acc.key() == *signer && acc.is_signer) {
                signatures += 1;
            }
        }
        require!(
            signatures >= multi_sig.threshold as usize,
            FactoryError::InsufficientSignatures
        );
        return Ok(());
    }
    
    err!(FactoryError::Unauthorized)
}

// Verifying key creation with multi-sig
pub fn create_verifying_key(
    ctx: Context<CreateVerifyingKey>,
    // ... args ...
) -> Result<()> {
    // Require multi-sig for critical operations
    require_authority_or_multisig(&ctx, &ctx.accounts.factory_state)?;
    
    // Additional validation
    // ... existing code ...
}

// Emergency pause
pub fn emergency_pause(
    ctx: Context<EmergencyPause>,
) -> Result<()> {
    let state = &ctx.accounts.factory_state;
    let mut signatures = 0;
    
    for signer in &state.emergency_pause_signers {
        if ctx.remaining_accounts.iter().any(|acc| acc.key() == *signer && acc.is_signer) {
            signatures += 1;
        }
    }
    
    require!(
        signatures >= 3, // Require 3-of-N emergency signers
        FactoryError::InsufficientEmergencySignatures
    );
    
    state.paused = true;
    Ok(())
}
```

