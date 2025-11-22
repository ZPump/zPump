# No Authority Change Mechanism

**Severity**: CRITICAL

## Description

The factory program has no mechanism to change the factory authority. If the authority key is compromised, lost, or needs to be rotated for security reasons, there is no way to recover or update it. This creates a permanent single point of failure.

## Vulnerability Details

The `FactoryState` struct contains an `authority` field that is set during initialization and can never be changed. While there is an `UpdateFactoryAuthority` account struct defined, there is no instruction that uses it to change the authority.

The authority has significant power:
- Can pause/unpause the factory
- Can freeze/thaw mint mappings
- Can register new mints
- Can create verifying keys
- Can queue timelock actions
- Can cancel timelock actions

If this authority is compromised, an attacker could:
1. Pause the entire factory, freezing all operations
2. Register malicious mints
3. Create malicious verifying keys
4. Cancel legitimate timelock actions
5. Freeze/thaw mints arbitrarily

## Code References

```28:44:programs/factory/src/lib.rs
pub fn initialize_factory(
    ctx: Context<InitializeFactory>,
    authority: Pubkey,
    default_fee_bps: u16,
    timelock_seconds: i64,
) -> Result<()> {
    // ... validation ...
    let state = &mut ctx.accounts.factory_state;
    state.authority = authority;
    // ... no way to change this later ...
}
```

```661:666:programs/factory/src/lib.rs
#[derive(Accounts)]
pub struct UpdateFactoryAuthority<'info> {
    #[account(mut, has_one = authority)]
    pub factory_state: Account<'info, FactoryState>,
    pub authority: Signer<'info>,
}
```

The `UpdateFactoryAuthority` struct exists but is never used to change the authority.

## Exploitation Scenario

1. **Key Compromise**: If the authority private key is compromised (phishing, malware, insider threat), the attacker gains full control.
2. **Key Loss**: If the authority key is lost (hardware failure, accidental deletion), the factory becomes permanently ungovernable.
3. **No Recovery**: There is no way to recover from either scenario - the factory is permanently locked to the compromised or lost key.

## Mitigation

1. **Add Authority Change via Timelock**: Implement a `ChangeAuthority` timelock action that allows changing the factory authority through the timelock mechanism.

2. **Multi-Signature Authority**: Consider using a multi-signature wallet as the factory authority to reduce single point of failure risk.

3. **Emergency Recovery Mechanism**: Implement an emergency recovery mechanism (e.g., multi-sig recovery, DAO governance) that can change the authority in extreme circumstances.

4. **Key Rotation Policy**: Establish a key rotation policy and implement the mechanism to support it.

## Recommended Code Changes

Add a new timelock action:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum TimelockAction {
    // ... existing actions ...
    ChangeAuthority {
        new_authority: Pubkey,
    },
}
```

Add execution logic in `execute_timelock_action`:

```rust
match &entry.action {
    // ... existing actions ...
    TimelockAction::ChangeAuthority { new_authority } => {
        state.authority = *new_authority;
        emit!(AuthorityChanged {
            old_authority: state.authority, // Note: this is the old one before update
            new_authority: *new_authority,
        });
    }
}
```

Add a new event:

```rust
#[event]
pub struct AuthorityChanged {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
```

## Additional Considerations

- The authority change should require a longer timelock period than other actions (e.g., 7 days instead of 24 hours).
- Consider requiring multiple confirmations or a multi-step process for authority changes.
- Implement monitoring and alerting for authority change attempts.

