# 1. Pool: Unshield nullifiers never recorded (Critical)

**Summary.** `process_unshield` never touches `ctx.accounts.nullifier_set`, so the nullifiers proved in the SNARK are never persisted. Attackers can resubmit the same unshield proof forever because nothing marks the notes as spent.

**Mitigation plan.**
1. Inside `process_unshield`, immediately after verifying the proof (before touching the commitment tree), load the nullifier set via `let mut nullifier_set = ctx.accounts.nullifier_set.load_mut()?;`.
2. Iterate over `args.nullifiers`, calling `nullifier_set.insert(*nullifier)?;` just like `execute_private_transfer` does, and emit the `PTFNullifierUsed` event for parity. Reuse the existing `process_nullifiers` helper if desired.
3. Add a regression test that attempts to unshield twice with the same nullifier and expects a `PoolError::NullifierReuse` failure.
