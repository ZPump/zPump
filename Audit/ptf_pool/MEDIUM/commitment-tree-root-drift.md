# Commitment Tree Root Drift Handling

## Severity: MEDIUM

## Description

The code allows root drift between the commitment tree and pool state, accepting operations if the tree root is in recent roots even if it doesn't match the current root. While this handles desync, it could potentially allow operations on stale states.

## Vulnerability Details

### Current Implementation

```1883:1898:programs/pool/src/lib.rs
// CRITICAL FIX: Root validation before unshield - allow if roots match OR tree root is known
{
    let commitment_tree = commitment_tree_loader_ref.load()?;
    // Check that proof old_root matches pool state root
    require!(
        pool_state.current_root == args.old_root,
        PoolError::RootMismatch
    );
    // Check that tree root matches proof old_root OR is in recent roots (handles desync)
    let tree_matches_proof = commitment_tree.current_root == args.old_root;
    let tree_root_is_known = pool_state.is_known_root(&commitment_tree.current_root);
    require!(
        tree_matches_proof || tree_root_is_known,
        PoolError::RootDrift
    );
}
```

### Potential Vulnerabilities

1. **Stale Root Acceptance**: If the tree root is in recent roots but doesn't match current root, operations might proceed on a stale state.

2. **Desync Exploitation**: An attacker might be able to cause desync and then exploit the drift handling to:
   - Use stale roots
   - Bypass intended state checks
   - Cause inconsistencies

3. **Root History Manipulation**: If root history can be manipulated, the drift handling could be exploited.

## Exploitation Scenario

```rust
// Scenario: Root drift exploitation
// 1. Attacker causes desync between tree and pool state
// 2. Tree root is in recent roots but not current
// 3. Attacker uses old root in proof
// 4. Drift handling allows operation
// 5. Operation proceeds on stale state
// 6. Potential inconsistencies or exploits
```

## Code References

- Root drift handling: Lines 1883-1898
- is_known_root: Line 3662
- Root history: MAX_ROOTS = 64

## Mitigation

1. **Stricter root validation**:
```rust
// CRITICAL FIX: Require exact root match, only allow drift in exceptional cases
{
    let commitment_tree = commitment_tree_loader_ref.load()?;
    
    // Primary check: roots must match exactly
    require!(
        pool_state.current_root == args.old_root,
        PoolError::RootMismatch
    );
    require!(
        commitment_tree.current_root == args.old_root,
        PoolError::RootDrift
    );
    
    // Only allow drift if explicitly authorized and root is recent
    // This should be rare and logged
    if commitment_tree.current_root != args.old_root {
        let tree_root_is_known = pool_state.is_known_root(&commitment_tree.current_root);
        require!(
            tree_root_is_known,
            PoolError::RootDrift
        );
        // Log warning for monitoring
        msg!("WARNING: Root drift detected - tree_root={:?}, proof_root={:?}", 
             commitment_tree.current_root, args.old_root);
    }
}
```

2. **Add root synchronization check**:
```rust
// After operation, verify roots are synchronized
// If not, log error and potentially halt operations
```

3. **Add monitoring and alerting**:
```rust
// Log all root drift occurrences
// Alert if drift happens frequently (indicates bug or attack)
```

4. **Consider root synchronization instruction**:
```rust
// Add instruction to manually synchronize roots if drift occurs
// Require authority to prevent abuse
```

## Additional Considerations

- Root drift handling is necessary for resilience but should be rare
- Consider whether drift should halt operations or just log warnings
- Add comprehensive tests for root drift scenarios
- Monitor drift frequency in production

