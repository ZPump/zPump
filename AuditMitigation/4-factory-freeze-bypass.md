# 4. Factory: PTKN freeze bypass (High)

**Summary.** `mint_ptkn` checks `has_ptkn` but never checks `MintMapping.status`, so governance freezes (`freeze_mapping`) do not stop pools from minting twin tokens through the factory CPI.

**Mitigation plan.**
1. At the top of `mint_ptkn`, either deserialize the mapping’s `status` byte (like `ensure_mint_active`) or call a shared helper to ensure the mapping is `MintStatus::Active`.
2. Propagate a distinct error (e.g., `FactoryError::MintFrozen`) so downstream programs can surface an actionable failure.
3. Add an integration test where governance freezes a mapping, attempts to unshield-to-PTKN, and expects the CPI to fail until `thaw_mapping` is invoked.
