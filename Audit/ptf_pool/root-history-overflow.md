# Root History Overflow and Loss

## Severity: MEDIUM

## Description

The pool maintains a history of recent roots in `recent_roots` array with `MAX_ROOTS = 16`. When the history overflows, old roots are shifted out and lost. This means proofs using old roots (beyond the 16 most recent) will be rejected as `UnknownRoot`, potentially locking funds if users try to unshield using old proofs.

## Vulnerability Details

### Current Implementation

```rust
pub const MAX_ROOTS: usize = 16;

pub fn push_root(&mut self, root: [u8; 32]) {
    if self.roots_len as usize >= Self::MAX_ROOTS {
        // Shift all roots left, losing the oldest
        for idx in 1..Self::MAX_ROOTS {
            self.recent_roots[idx - 1] = self.recent_roots[idx];
        }
        self.recent_roots[Self::MAX_ROOTS - 1] = root;
        self.current_root = root;
    } else {
        self.recent_roots[self.roots_len as usize] = root;
        self.roots_len += 1;
        self.current_root = root;
    }
}

pub fn is_known_root(&self, candidate: &[u8; 32]) -> bool {
    if &self.current_root == candidate {
        return true;
    }
    for idx in 0..self.roots_len as usize {
        if &self.recent_roots[idx] == candidate {
            return true;
        }
    }
    false
}
```

The behavior:
- Only tracks 16 most recent roots
- When overflow occurs, oldest root is lost
- `is_known_root` only checks recent 16 roots
- Old proofs become invalid

### Potential Vulnerabilities

1. **Fund Locking**: If a user has a valid proof using an old root (beyond 16 most recent), they cannot unshield, effectively locking their funds.

2. **Proof Expiration**: Valid proofs become unusable after 16 operations, creating an artificial expiration that users might not be aware of.

3. **DoS Through Root Flooding**: An attacker could perform many operations to push old roots out of history, invalidating legitimate user proofs.

4. **No Warning Mechanism**: Users are not warned when their proofs are about to expire.

5. **Inconsistent Behavior**: The system accepts proofs but then rejects them if roots are too old, creating confusion.

## Exploitation Scenario

```rust
// Scenario 1: Fund locking
// 1. User creates shield proof with root R1
// 2. 17 more operations occur (shields/unshields)
// 3. Root R1 is pushed out of recent_roots
// 4. User tries to unshield using proof with root R1
// 5. is_known_root(R1) returns false
// 6. Transaction fails with UnknownRoot
// 7. User's funds are locked

// Scenario 2: DoS attack
// 1. Attacker performs 16+ operations
// 2. All old roots are pushed out
// 3. Legitimate users with old proofs cannot unshield
// 4. Funds are locked
// 5. System becomes unusable for users with old proofs

// Scenario 3: Proof expiration
// 1. User creates proof but doesn't use it immediately
// 2. Many operations occur
// 3. Root used in proof is pushed out
// 4. Proof becomes unusable
// 5. User loses ability to unshield
```

## Code References

- MAX_ROOTS: Line 2943
- push_root: Lines 2946-2958
- is_known_root: Lines 2960-2970
- Root validation: Lines 1418, 1154

## Mitigation

1. **Increase MAX_ROOTS**: Increase the limit to track more roots:

```rust
pub const MAX_ROOTS: usize = 256;  // Or higher, depending on use case
```

2. **Use Commitment Tree for Root Validation**: Instead of relying only on `recent_roots`, validate roots against the commitment tree's actual history:

```rust
pub fn is_known_root(&self, candidate: &[u8; 32], commitment_tree: &CommitmentTree) -> bool {
    // Check recent roots first (fast path)
    if &self.current_root == candidate {
        return true;
    }
    for idx in 0..self.roots_len as usize {
        if &self.recent_roots[idx] == candidate {
            return true;
        }
    }
    
    // Fallback: Check against commitment tree's actual root history
    // This requires commitment tree to maintain root history
    commitment_tree.is_known_root(candidate)
}
```

3. **Store Root History in Separate Account**: Use a separate account to store root history, allowing unlimited history:

```rust
#[account]
pub struct RootHistory {
    pub pool: Pubkey,
    pub roots: Vec<[u8; 32]>,  // Can grow as needed
    pub bump: u8,
}
```

4. **Use Merkle Tree of Roots**: Store roots in a Merkle tree, allowing efficient validation of any historical root.

5. **Add Root Expiration Warning**: Emit events when roots are about to expire, warning users to use their proofs.

6. **Allow Root Refresh**: Allow users to "refresh" their proofs by creating new proofs from current state if old roots expire.

7. **Document Root Expiration**: Clearly document that proofs expire after MAX_ROOTS operations.

8. **Increase Limit Based on Usage**: Dynamically adjust MAX_ROOTS based on pool usage patterns.

Note: The 16-root limit is likely a space optimization, but it creates a critical usability and security issue. A better approach would be to use the commitment tree itself for root validation, as it maintains the actual Merkle tree state.

