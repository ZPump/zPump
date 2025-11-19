# Mitigation: Unshield Circuit Root Mismatch Still Exists

## Severity: CRITICAL
## Contract: ptf_pool
## Issue ID: 4

## Problem Description

Same issue as transfer - the unshield circuit's new_root computation includes change commitments but may not exactly match the tree's computation due to tree structure. The code acknowledges this (lines 1507-1518) but still has a mismatch.

## Security Impact

1. **Same as transfer circuit mismatch** - Root mismatch between proof and reality
2. **Potential state inconsistency** - Proofs could validate incorrect roots
3. **Risk of accepting invalid proofs** - State could diverge from proof validation

## Mitigation

Same approach as transfer circuit - either update circuit or add enhanced validation.

See `03-PoolTransferRootMismatch.md` for detailed mitigation strategies.

**Key Difference:**
Unshield circuit already includes change commitments in root computation:
```
new_root = poseidon(old_root, nullifier, change_commitment, change_amount_commitment)
```

But tree computation may differ due to tree structure/ordering.

## Recommended

Ensure circuit's new_root computation exactly matches tree's root computation algorithm, or add validation that they match after accounting for tree structure differences.

## References

- Issue location: `programs/pool/src/lib.rs:1496-1519`
- TODO comment: `programs/pool/src/lib.rs:1507-1518`
- Unshield public input validation: `programs/pool/src/lib.rs:3730-3890`

