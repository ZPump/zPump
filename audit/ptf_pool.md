# Security Audit Report: ptf_pool

## Program Overview
- **Program ID**: `7kbUWzeTPY6qb1mFJC1ZMRmTZAdaHC27yukc3Czj7fKh`
- **Purpose**: Core pool program handling shielding (wrap), unshielding (unwrap), private transfers, and Merkle tree management
- **Language**: Rust (Anchor framework)

## Critical Security Issues

### 1. CRITICAL: Root Mismatch Only Logged, Not Rejected
**Severity**: CRITICAL (10/10)
**Location**: Lines 953-960, 1226-1233

**Issue**: In both `execute_private_transfer` and `process_unshield`, when the computed Merkle root doesn't match the proof-supplied root, the code only logs a message but continues execution with the computed root. This breaks the zero-knowledge proof security model.

**Code Reference**:
```rust
if new_root != args.new_root {
    msg!(
        "unshield proof new root ({}) differs from computed root ({})",
        hex::encode(args.new_root),
        hex::encode(new_root)
    );
}
pool_state.push_root(new_root);
```

**Why This Is Critical**: 
- The ZK proof guarantees that the new_root in public inputs is correct
- If they don't match, either the proof is invalid or the on-chain computation is wrong
- Accepting a mismatched root allows an attacker to potentially manipulate the tree state
- This violates the fundamental security property of the privacy protocol

**Recommendation**: 
```rust
require!(
    new_root == args.new_root,
    PoolError::RootMismatch
);
```

### 2. CRITICAL: Authority-Only Functions Can Manipulate Core State
**Severity**: CRITICAL (9/10)
**Location**: Lines 762-781

**Issue**: `accept_root` and `write_nullifier` are protected only by `UpdateAuthority` constraint, which checks `has_one = authority`. These functions can directly manipulate the Merkle tree state and nullifier set without any proof verification.

**Code Reference**:
```rust
pub fn accept_root(ctx: Context<UpdateAuthority>, root: [u8; 32]) -> Result<()> {
    let mut pool_state = ctx.accounts.pool_state.load_mut()?;
    pool_state.push_root(root);
    Ok(())
}

pub fn write_nullifier(ctx: Context<UpdateAuthority>, nullifier: [u8; 32]) -> Result<()> {
    let mut nullifier_set = ctx.accounts.nullifier_set.load_mut()?;
    nullifier_set.insert(nullifier).map_err(|_| PoolError::NullifierReuse)?;
    // ...
}
```

**Why This Is Critical**:
- If the authority key is compromised, an attacker can:
  - Add arbitrary roots to bypass proof verification
  - Mark nullifiers as used without actually spending notes
  - Break the privacy guarantees and enable double-spending
- No timelock or multi-sig protection
- These functions should likely not exist or require additional safeguards

**Recommendation**: 
- Remove these functions entirely if not needed
- If needed for emergency recovery, add timelock and multi-sig requirements
- Add comprehensive logging and monitoring
- Consider requiring a governance vote

### 3. HIGH: Shield Finalization Check Can Be Bypassed
**Severity**: HIGH (8/10)
**Location**: Lines 559-603

**Issue**: The `shield` function checks for a `shield_finalize_ledger` instruction in the transaction, but this check searches through instructions and can potentially be bypassed if the instruction appears in a different form or if the transaction structure is manipulated.

**Code Reference**:
```rust
fn is_finalize_ix(ix: &Instruction, pool_key: Pubkey) -> bool {
    ix.program_id == crate::ID
        && ix.data.len() >= 8
        && ix.data[..8] == instruction_discriminator("shield_finalize_ledger")
        && ix.accounts.first().map(|meta| meta.pubkey) == Some(pool_key)
}
```

**Why This Is High**:
- The check relies on instruction ordering and structure
- A malicious transaction could potentially structure instructions to bypass this check
- The shield operation deposits tokens before finalization, creating a window for exploitation

**Recommendation**:
- Use a state machine pattern with explicit stage tracking
- Require finalization in the same transaction as a hard constraint
- Consider atomic multi-instruction patterns

### 4. HIGH: Hook System Allows Arbitrary Program Execution
**Severity**: HIGH (8/10)
**Location**: Lines 659-720 (shield_finalize_ledger), hook configuration

**Issue**: The hook system allows calling arbitrary programs after shield/unshield operations. While there are some account validation checks, the system is complex and could allow malicious hooks to drain funds or manipulate state.

**Code Reference**:
```rust
if post_shield_enabled {
    // ... hook execution logic
    invoke_signed(&hook_ix, &hook_accounts, &signer_seeds)?;
}
```

**Why This Is High**:
- Hooks execute with pool authority, giving them significant power
- Malicious hook programs could potentially:
  - Drain vault funds
  - Manipulate pool state
  - Bypass security checks
- The `HookAccountMode::Strict` helps but may not catch all cases

**Recommendation**:
- Implement a whitelist of allowed hook programs
- Add comprehensive hook program audits before enabling
- Limit hook permissions (read-only where possible)
- Add timelock for hook configuration changes

### 5. MEDIUM: Reentrancy Risk in Multi-Step Operations
**Severity**: MEDIUM (6/10)
**Location**: Shield/unshield flows

**Issue**: The shield operation is split across multiple instructions (`shield`, `shield_finalize_tree`, `shield_finalize_ledger`, `shield_check_invariant`). While Solana's transaction model provides some protection, there are still risks in the state transitions.

**Why This Is Medium**:
- Solana transactions are atomic, but the multi-step pattern creates complexity
- State inconsistencies could occur if intermediate steps fail
- The `pending_shield` state tracking helps but adds attack surface

**Recommendation**:
- Simplify to fewer steps where possible
- Add comprehensive state validation at each step
- Implement rollback mechanisms for failed operations

### 6. MEDIUM: Nullifier Set Uses Bloom Filter
**Severity**: MEDIUM (6/10)
**Location**: NullifierSet implementation

**Issue**: The nullifier set uses a Bloom filter, which has a non-zero false positive rate. While this is likely intentional for gas efficiency, it means there's a small chance of false positives preventing legitimate transactions.

**Why This Is Medium**:
- False positives could lock legitimate users out
- The false positive rate should be well-documented and acceptable
- Need to ensure the Bloom filter size is appropriate for expected nullifier count

**Recommendation**:
- Document the false positive rate
- Consider a hybrid approach (Bloom filter + exact set for recent nullifiers)
- Add monitoring for false positive events

### 7. MEDIUM: Allowance System Race Condition
**Severity**: MEDIUM (5/10)
**Location**: Lines 820-869 (transfer_from)

**Issue**: The `transfer_from` function checks and decrements allowance in separate operations. While Solana transactions are atomic, there's still a risk if the same allowance is used in multiple transactions in the same block.

**Code Reference**:
```rust
require!(
    allowance.amount >= args.allowance_amount,
    PoolError::AllowanceInsufficient
);
allowance.amount = allowance.amount.checked_sub(args.allowance_amount)?;
```

**Why This Is Medium**:
- In Solana, transactions in the same block are processed sequentially
- However, if multiple transactions using the same allowance are included, the second could fail unexpectedly
- This is more of a UX issue than a security issue, but could be exploited for griefing

**Recommendation**:
- The current implementation is actually safe due to Solana's sequential processing
- Consider adding clearer error messages for users

### 8. LOW: Missing Input Validation on Public Inputs
**Severity**: LOW (4/10)
**Location**: Various proof verification points

**Issue**: While public inputs are parsed and validated, there could be edge cases where malformed inputs cause unexpected behavior.

**Recommendation**:
- Add comprehensive bounds checking
- Validate all field element conversions
- Add explicit error handling for all parsing operations

### 9. LOW: Event Emissions Don't Include All Critical Data
**Severity**: LOW (3/10)
**Location**: Event definitions

**Issue**: Some events may not include all data needed for off-chain monitoring and auditing.

**Recommendation**:
- Review all events to ensure they include sufficient data for auditing
- Add events for all state-changing operations
- Include timestamps and block information where relevant

## Positive Security Features

1. **Comprehensive Account Validation**: The code extensively validates account relationships and PDAs
2. **Feature Flags**: Good use of feature flags for optional functionality
3. **Invariant Checks**: Optional invariant checks help ensure consistency
4. **Proof Verification**: Proper integration with Groth16 verifier
5. **Mint Status Checks**: Validates mint status before operations

## Recommendations Summary

1. **IMMEDIATE**: Fix root mismatch handling - reject mismatched roots
2. **IMMEDIATE**: Review or remove `accept_root` and `write_nullifier` functions
3. **HIGH PRIORITY**: Strengthen hook system security (whitelist, audits)
4. **HIGH PRIORITY**: Improve shield finalization checks
5. **MEDIUM PRIORITY**: Document Bloom filter false positive rate
6. **MEDIUM PRIORITY**: Add comprehensive input validation
7. **LOW PRIORITY**: Enhance event emissions for auditing

## Overall Security Score: 6.5/10

The program has a solid foundation with good account validation and proof verification, but critical issues around root handling and authority functions need immediate attention.

