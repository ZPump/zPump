# 5. Factory – PTKN freeze authority is never reclaimed

* **Problem.** When reusing an existing PTKN mint, `prepare_ptkn_mint` reassigns the mint authority but never inspects or resets the freeze (or close) authority fields, leaving them under attacker control.【F:programs/factory/src/lib.rs†L845-L903】
* **Exploitation path.** Provide a mint whose freeze authority belongs to the attacker, register it with the factory, and later freeze every user account or the mint itself to halt redemptions.
* **Mitigations.**
  1. Require the caller to pass in the current freeze authority signer and call `set_authority` for both `AuthorityType::MintTokens` and `AuthorityType::FreezeAccount` (and optionally `CloseAccount`).
  2. Reject any reused mint whose freeze authority is not already the factory PDA or `None`.
  3. Add regression tests that prove all PTKN mint authorities are under program control before activating a mapping.
