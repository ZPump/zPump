# PTF Pool Program Audit

## Critical Findings

1. **Proof verification can be bypassed entirely**  
   `ptf_pool` trusts the CPI into `ptf_verifier_groth16::verify_groth16` before every shield, unshield, and private transfer, e.g.:

```342:389:programs/pool/src/lib.rs
        let cpi_accounts = ptf_verifier_groth16::cpi::accounts::VerifyGroth16 {
            verifier_state: ctx.accounts.verifying_key.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.verifier_program.to_account_info(),
            cpi_accounts,
        );
        ptf_verifier_groth16::cpi::verify_groth16(
            cpi_ctx,
            pool_state.verifying_key_id,
            args.proof.clone(),
            args.public_inputs.clone(),
        )?;
```
   However, the verifier program’s on-chain implementation currently returns `true` for every proof (see `ptf_verifier_groth16` report). As a result, any attacker can forge shields/unshields without supplying a valid Groth16 proof and siphon all vault liquidity. **Recommendation:** gate mainnet deployments until `ptf_verifier_groth16` actually calls the Groth16 syscall, add an integration test that fails if verification ever returns `true` on empty inputs, and consider guarding `pool_state.verifier_program` behind a known allowlist until audits pass.

2. **Nullifier storage exhausts after 256 spends**  
   The `NullifierSet` account only tracks 256 entries before permanently throwing `NullifierCapacity`:

```2464:2487:programs/pool/src/lib.rs
pub struct NullifierSet {
    pub pool: Pubkey,
    pub count: u32,
    pub entries: [[u8; 32]; NullifierSet::MAX_NULLIFIERS],
    pub bloom: [u8; NullifierSet::BLOOM_BYTES],
    pub bump: u8,
}

impl NullifierSet {
    pub const MAX_NULLIFIERS: usize = 256;
...
        require!(
            (self.count as usize) < Self::MAX_NULLIFIERS,
            PoolError::NullifierCapacity,
        );
```
   There is no instruction to rotate, reset, or shard this PDA. After only 256 unshields or private transfers, every subsequent call to `insert` fails and the pool becomes permanently unusable—an attacker can force this with small-value notes. **Recommendation:** store nullifiers in an append-only Vector account, paginate by epochs, or at minimum expose an admin instruction to rotate the PDA once it nears capacity.

## Medium Findings

1. **Mint freeze/thaw has no effect**  
   The factory program updates `MintMapping.status` (see factory report), but `ptf_pool` never reads that field—shield/unshield logic only checks `origin_mint`, `decimals`, `features`, and PTKN flags. Governance therefore cannot disable a compromised mint even after calling `freeze_mapping`. **Recommendation:** add `require!(mint_mapping.status == MintStatus::Active, ...)` to shield/unshield/transfer entrypoints so that factory controls actually propagate on-chain.

2. **Shield finalisation isn’t enforced per transaction**  
   `shield` tries to ensure the complementary `shield_finalize_ledger` instruction is present, but missing enforcement simply logs a message:

```392:436:programs/pool/src/lib.rs
        if !finalize_found {
            msg!("shield finalize instruction not detected; skipping enforcement");
        }
```
   An attacker can submit a shield without finalising, leaving `pending_shield` active and blocking every subsequent deposit until a benevolent third party pays to finalise the claim. **Recommendation:** revert when the companion instruction is missing, or automatically finalise within the same handler.

## Reliability & Gas Improvements

- Cache `pool_state.load()?` results instead of reloading the account dozens of times per instruction; each `load()` is an expensive deserialisation.
- `validate_hook_accounts` allocates intermediate `Vec`s on every call; accepting iterators or using fixed-size arrays would save heap and CU during hooked shields/unshields.
- `parse_field_elements` clones the entire public input buffer; parsing in-place (or sharing slices) can cut heap allocations during proof-heavy flows.
