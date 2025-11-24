# Hook Whitelist Integrity Not Validated on Read

**Severity:** LOW

**Location:** `programs/pool/src/lib.rs:5658-5669` (validate_integrity exists but never called)

## Description

The `HookWhitelist` struct has a `validate_integrity()` method that checks if `allowed_programs.len() <= MAX_PROGRAMS`, but this method is never called when the whitelist is used. If the whitelist state is corrupted (e.g., through a bug or state manipulation), it could exceed `MAX_PROGRAMS` without being detected.

## Code Reference

### validate_integrity Method (line 5663-5669):
```rust
// CRITICAL FIX: Validate whitelist integrity to prevent unbounded growth
pub fn validate_integrity(&self) -> Result<()> {
    require!(
        self.allowed_programs.len() <= Self::MAX_PROGRAMS,
        PoolError::WhitelistFull
    );
    Ok(())
}
```

### Usage Points (never calls validate_integrity):
- `is_allowed()` (line 5658) - Used to check if hook is whitelisted
- `add_hook_to_whitelist()` (line 949) - Checks length before adding, but doesn't validate existing state
- `remove_hook_from_whitelist()` (line 991) - Doesn't validate integrity
- Hook execution (lines 2471, 5335) - Uses `is_allowed()` but doesn't validate integrity

## Issue

1. **validate_integrity never called** - The method exists but is never invoked
2. **No validation on read** - When `is_allowed()` is called, there's no check that the whitelist is in a valid state
3. **State corruption risk** - If state is corrupted (e.g., through a bug), the whitelist could exceed MAX_PROGRAMS without detection

## Impact

- **Low impact** since:
  - `add_hook_to_whitelist` checks length before adding (prevents growth beyond MAX)
  - Account space is fixed (SPACE constant prevents unbounded growth)
  - State corruption would require a bug or malicious manipulation
- **Defensive programming gap** - Missing validation that could catch state corruption early

## Attack Scenario

1. Attacker finds a way to corrupt whitelist state (unlikely but possible through bugs)
2. Whitelist exceeds MAX_PROGRAMS
3. Operations continue without detecting the corruption
4. Could lead to unexpected behavior or DoS if vector operations are affected

## Current Mitigations

- Account space is fixed (`SPACE` constant limits maximum size)
- `add_hook_to_whitelist` checks length before adding
- Anchor account constraints prevent unbounded growth
- However, no runtime validation of existing state

## Recommendation

1. **Call validate_integrity in is_allowed()** (defensive but adds compute cost):
   ```rust
   pub fn is_allowed(&self, hook_program: &Pubkey) -> bool {
       // Optional: Validate integrity on read (adds compute cost)
       // self.validate_integrity().ok(); // Log warning but don't fail
       self.allowed_programs.contains(hook_program)
   }
   ```

2. **Call validate_integrity in add_hook_to_whitelist** before adding:
   ```rust
   whitelist.validate_integrity()?; // Validate existing state
   require!(
       whitelist.allowed_programs.len() < HookWhitelist::MAX_PROGRAMS,
       PoolError::WhitelistFull
   );
   ```

3. **Call validate_integrity in remove_hook_from_whitelist**:
   ```rust
   whitelist.validate_integrity()?; // Validate before removal
   // ... removal logic
   ```

4. **Or remove the method** if it's not needed (since Anchor constraints prevent unbounded growth)

## Related Code

- `programs/pool/src/lib.rs:5654` - `HookWhitelist` struct
- `programs/pool/src/lib.rs:949` - `add_hook_to_whitelist` function
- `programs/pool/src/lib.rs:991` - `remove_hook_from_whitelist` function

