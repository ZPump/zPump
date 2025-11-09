//! State machine modelling the shielded pool behaviour.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;

use ptf_common::{
    FeatureFlags, Pubkey, FEATURE_HOOKS, FEATURE_PRIVATE_TRANSFER, FEE_BPS_DEFAULT, MAX_BPS,
};
use ptf_vault::Vault;

/// Type alias for note identifiers.
pub type NoteId = [u8; 32];
/// Type alias for nullifier identifiers.
pub type Nullifier = [u8; 32];
/// Type alias for Merkle roots.
pub type Root = [u8; 32];
/// Type alias for commitment fingerprints.
pub type Commitment = [u8; 32];

/// Data describing a live note inside the pool.
#[derive(Debug, Clone)]
pub struct Note {
    commitment: Commitment,
    amount: u64,
}

impl Note {
    fn new(commitment: Commitment, amount: u64) -> Self {
        Self { commitment, amount }
    }
}

/// Outputs created during an operation.
#[derive(Debug, Clone)]
pub struct NoteCreation {
    pub id: NoteId,
    pub commitment: Commitment,
    pub amount: u64,
}

/// Configuration for hook invocations (disabled in MVP).
#[derive(Debug, Clone)]
pub struct HookConfig {
    pub post_shield_program_id: Pubkey,
    pub post_unshield_program_id: Pubkey,
    pub required_accounts: Vec<Pubkey>,
    pub strict: bool,
}

/// Result from an unshield operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnshieldOutcome {
    pub destination: Pubkey,
    pub amount_released: u64,
    pub fee_charged: u64,
}

/// Errors raised by the pool.
#[derive(Debug, PartialEq, Eq)]
pub enum PoolError {
    NoteNotFound,
    NoteAlreadyExists,
    NullifierReuse,
    HooksDisabled,
    FeatureDisabled(&'static str),
    InvalidAmount,
    FeeOverflow,
    InvariantBreach {
        vault_balance: u64,
        ptoken_supply: u64,
        live_notes: u64,
        protocol_fees: i128,
    },
    Vault(ptf_vault::VaultError),
}

impl fmt::Display for PoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PoolError::NoteNotFound => write!(f, "note not found"),
            PoolError::NoteAlreadyExists => write!(f, "note already exists"),
            PoolError::NullifierReuse => write!(f, "nullifier already used"),
            PoolError::HooksDisabled => write!(f, "hooks are disabled"),
            PoolError::FeatureDisabled(name) => write!(f, "feature disabled: {}", name),
            PoolError::InvalidAmount => write!(f, "invalid amount balance"),
            PoolError::FeeOverflow => write!(f, "fee calculation overflow"),
            PoolError::InvariantBreach {
                vault_balance,
                ptoken_supply,
                live_notes,
                protocol_fees,
            } => write!(
                f,
                "invariant breach: vault={} ptoken={} live_notes={} fees={}",
                vault_balance, ptoken_supply, live_notes, protocol_fees
            ),
            PoolError::Vault(err) => write!(f, "vault error: {}", err),
        }
    }
}

impl Error for PoolError {}

impl From<ptf_vault::VaultError> for PoolError {
    fn from(value: ptf_vault::VaultError) -> Self {
        PoolError::Vault(value)
    }
}

/// Core pool state for a single origin mint.
#[derive(Debug)]
pub struct PoolState {
    origin_mint: Pubkey,
    pool_authority: Pubkey,
    fee_bps: u16,
    features: FeatureFlags,
    hook_config: Option<HookConfig>,
    notes: HashMap<NoteId, Note>,
    nullifiers: HashSet<Nullifier>,
    current_root: Option<Root>,
    accepted_roots: Vec<Root>,
    protocol_fees: i128,
    ptoken_supply: u64,
}

impl PoolState {
    /// Constructs a new pool state instance.
    pub fn new(origin_mint: Pubkey, pool_authority: Pubkey) -> Self {
        Self {
            origin_mint,
            pool_authority,
            fee_bps: FEE_BPS_DEFAULT,
            features: FeatureFlags::default(),
            hook_config: None,
            notes: HashMap::new(),
            nullifiers: HashSet::new(),
            current_root: None,
            accepted_roots: Vec::new(),
            protocol_fees: 0,
            ptoken_supply: 0,
        }
    }

    /// Returns the current feature flags.
    pub fn features(&self) -> FeatureFlags {
        self.features
    }

    /// Sets new feature flags.
    pub fn set_features(&mut self, flags: FeatureFlags) {
        self.features = flags;
    }

    /// Configures the pool fee in basis points.
    pub fn set_fee_bps(&mut self, fee_bps: u16) -> Result<(), PoolError> {
        if fee_bps > MAX_BPS {
            return Err(PoolError::InvalidAmount);
        }
        self.fee_bps = fee_bps;
        Ok(())
    }

    /// Configures the hook metadata. Hooks must be enabled through feature flags separately.
    pub fn set_hook_config(&mut self, config: HookConfig) {
        self.hook_config = Some(config);
    }

    /// Returns the total amount of fees collected (absolute value of the accumulator).
    pub fn fees_collected(&self) -> u64 {
        self.protocol_fees.abs() as u64
    }

    /// Returns the current Merkle root.
    pub fn current_root(&self) -> Option<Root> {
        self.current_root
    }

    /// Adds a shield deposit to the pool.
    pub fn shield(
        &mut self,
        vault: &mut Vault,
        deposit_amount: u64,
        note_id: NoteId,
        commitment: Commitment,
        new_root: Root,
    ) -> Result<u64, PoolError> {
        if self.notes.contains_key(&note_id) {
            return Err(PoolError::NoteAlreadyExists);
        }
        let fee = self.calculate_fee(deposit_amount)?;
        if fee > deposit_amount {
            return Err(PoolError::InvalidAmount);
        }
        let note_amount = deposit_amount - fee;
        vault.deposit(deposit_amount)?;
        self.protocol_fees -= fee as i128;
        self.notes
            .insert(note_id, Note::new(commitment, note_amount));
        self.push_root(new_root);
        self.enforce_invariant(vault)?;
        Ok(note_amount)
    }

    /// Performs a private transfer within the pool.
    pub fn private_transfer(
        &mut self,
        vault: &Vault,
        nullifiers: &[Nullifier],
        inputs: &[NoteId],
        outputs: &[NoteCreation],
        new_root: Root,
    ) -> Result<(), PoolError> {
        if !self.features.contains(FEATURE_PRIVATE_TRANSFER) {
            return Err(PoolError::FeatureDisabled("private_transfer"));
        }
        self.validate_nullifiers(nullifiers)?;
        let input_sum = self.prepare_input_sum(inputs)?;
        let output_sum: u64 = outputs
            .iter()
            .try_fold(0u64, |acc, note| acc.checked_add(note.amount))
            .ok_or(PoolError::InvalidAmount)?;
        if input_sum != output_sum {
            return Err(PoolError::InvalidAmount);
        }
        self.consume_inputs(inputs, nullifiers);
        self.insert_outputs(outputs)?;
        self.push_root(new_root);
        self.enforce_invariant(vault)?;
        Ok(())
    }

    /// Unshields funds back to the origin mint.
    pub fn unshield_to_origin(
        &mut self,
        vault: &mut Vault,
        nullifiers: &[Nullifier],
        inputs: &[NoteId],
        outputs: &[NoteCreation],
        amount: u64,
        destination: Pubkey,
        new_root: Root,
    ) -> Result<UnshieldOutcome, PoolError> {
        if amount == 0 {
            return Err(PoolError::InvalidAmount);
        }
        self.validate_nullifiers(nullifiers)?;
        let input_sum = self.prepare_input_sum(inputs)?;
        let outputs_total = self.sum_outputs(outputs)?;
        let fee = self.calculate_fee(amount)?;
        let required_inputs = amount
            .checked_add(fee)
            .and_then(|v| v.checked_add(outputs_total))
            .ok_or(PoolError::InvalidAmount)?;
        if input_sum != required_inputs {
            return Err(PoolError::InvalidAmount);
        }
        self.consume_inputs(inputs, nullifiers);
        self.insert_outputs(outputs)?;
        self.protocol_fees -= fee as i128;
        vault.release(self.pool_authority, amount)?;
        self.push_root(new_root);
        self.enforce_invariant(vault)?;
        Ok(UnshieldOutcome {
            destination,
            amount_released: amount,
            fee_charged: fee,
        })
    }

    /// Unshields funds by minting privacy twin tokens.
    pub fn unshield_to_ptkn(
        &mut self,
        vault: &Vault,
        nullifiers: &[Nullifier],
        inputs: &[NoteId],
        outputs: &[NoteCreation],
        amount: u64,
        destination: Pubkey,
        new_root: Root,
    ) -> Result<UnshieldOutcome, PoolError> {
        if amount == 0 {
            return Err(PoolError::InvalidAmount);
        }
        if self.features.contains(FEATURE_HOOKS) && self.hook_config.is_none() {
            return Err(PoolError::HooksDisabled);
        }
        self.validate_nullifiers(nullifiers)?;
        let input_sum = self.prepare_input_sum(inputs)?;
        let outputs_total = self.sum_outputs(outputs)?;
        let fee = self.calculate_fee(amount)?;
        let required_inputs = amount
            .checked_add(fee)
            .and_then(|v| v.checked_add(outputs_total))
            .ok_or(PoolError::InvalidAmount)?;
        if input_sum != required_inputs {
            return Err(PoolError::InvalidAmount);
        }
        self.consume_inputs(inputs, nullifiers);
        self.insert_outputs(outputs)?;
        self.protocol_fees -= fee as i128;
        self.ptoken_supply = self
            .ptoken_supply
            .checked_add(amount)
            .ok_or(PoolError::InvalidAmount)?;
        self.push_root(new_root);
        self.enforce_invariant(vault)?;
        Ok(UnshieldOutcome {
            destination,
            amount_released: amount,
            fee_charged: fee,
        })
    }

    /// Returns the running sum of live notes.
    fn live_notes_value(&self) -> u64 {
        self.notes.values().map(|n| n.amount).sum()
    }

    fn validate_nullifiers(&self, nullifiers: &[Nullifier]) -> Result<(), PoolError> {
        let mut seen = HashSet::new();
        for nullifier in nullifiers {
            if !seen.insert(nullifier) {
                return Err(PoolError::NullifierReuse);
            }
            if self.nullifiers.contains(nullifier) {
                return Err(PoolError::NullifierReuse);
            }
        }
        Ok(())
    }

    fn prepare_input_sum(&self, inputs: &[NoteId]) -> Result<u64, PoolError> {
        let mut seen = HashSet::new();
        inputs.iter().try_fold(0u64, |acc, id| {
            if !seen.insert(id) {
                return Err(PoolError::InvalidAmount);
            }
            let note = self.notes.get(id).ok_or(PoolError::NoteNotFound)?;
            acc.checked_add(note.amount).ok_or(PoolError::InvalidAmount)
        })
    }

    fn consume_inputs(&mut self, inputs: &[NoteId], nullifiers: &[Nullifier]) {
        for (id, nullifier) in inputs.iter().zip(nullifiers.iter()) {
            self.notes.remove(id);
            self.nullifiers.insert(*nullifier);
        }
    }

    fn insert_outputs(&mut self, outputs: &[NoteCreation]) -> Result<(), PoolError> {
        for output in outputs {
            if self.notes.contains_key(&output.id) {
                return Err(PoolError::NoteAlreadyExists);
            }
        }
        for output in outputs {
            self.notes
                .insert(output.id, Note::new(output.commitment, output.amount));
        }
        Ok(())
    }

    fn sum_outputs(&self, outputs: &[NoteCreation]) -> Result<u64, PoolError> {
        outputs
            .iter()
            .try_fold(0u64, |acc, note| acc.checked_add(note.amount))
            .ok_or(PoolError::InvalidAmount)
    }

    fn calculate_fee(&self, amount: u64) -> Result<u64, PoolError> {
        let numerator = (amount as u128)
            .checked_mul(self.fee_bps as u128)
            .ok_or(PoolError::FeeOverflow)?;
        Ok((numerator / MAX_BPS as u128) as u64)
    }

    fn push_root(&mut self, new_root: Root) {
        self.current_root = Some(new_root);
        self.accepted_roots.push(new_root);
        const ROOT_WINDOW: usize = 32;
        if self.accepted_roots.len() > ROOT_WINDOW {
            let excess = self.accepted_roots.len() - ROOT_WINDOW;
            self.accepted_roots.drain(0..excess);
        }
    }

    fn enforce_invariant(&self, vault: &Vault) -> Result<(), PoolError> {
        let live_notes = self.live_notes_value();
        let vault_balance = vault.balance();
        let rhs = self
            .ptoken_supply
            .checked_add(live_notes)
            .and_then(|v| {
                if self.protocol_fees.is_negative() {
                    let fee: u64 = self.protocol_fees.unsigned_abs().try_into().ok()?;
                    v.checked_add(fee)
                } else {
                    let fee: u64 = self.protocol_fees.try_into().ok()?;
                    v.checked_sub(fee)
                }
            })
            .ok_or(PoolError::InvalidAmount)?;
        if vault_balance == rhs {
            Ok(())
        } else {
            Err(PoolError::InvariantBreach {
                vault_balance,
                ptoken_supply: self.ptoken_supply,
                live_notes,
                protocol_fees: self.protocol_fees,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: Pubkey = Pubkey::new([1u8; 32]);
    const POOL_AUTHORITY: Pubkey = Pubkey::new([2u8; 32]);
    const DESTINATION: Pubkey = Pubkey::new([3u8; 32]);

    fn note_id(value: u8) -> NoteId {
        [value; 32]
    }

    fn commitment(value: u8) -> Commitment {
        [value; 32]
    }

    fn root(value: u8) -> Root {
        [value; 32]
    }

    fn nullifier(value: u8) -> Nullifier {
        [value; 32]
    }

    #[test]
    fn shield_and_unshield_origin_preserves_invariant() {
        let mut vault = Vault::new(ORIGIN, POOL_AUTHORITY);
        let mut pool = PoolState::new(ORIGIN, POOL_AUTHORITY);

        let credited = pool
            .shield(&mut vault, 10_000, note_id(1), commitment(1), root(1))
            .expect("shield");
        assert_eq!(vault.balance(), 10_000);
        assert_eq!(pool.live_notes_value(), credited);

        let withdraw_amount = 9_500;
        let fee = pool.calculate_fee(withdraw_amount).unwrap();
        let change = credited - withdraw_amount - fee;
        let change_note = if change > 0 {
            vec![NoteCreation {
                id: note_id(9),
                commitment: commitment(9),
                amount: change,
            }]
        } else {
            Vec::new()
        };

        let outcome = pool
            .unshield_to_origin(
                &mut vault,
                &[nullifier(1)],
                &[note_id(1)],
                &change_note,
                withdraw_amount,
                DESTINATION,
                root(2),
            )
            .expect("unshield origin");
        assert_eq!(outcome.destination, DESTINATION);
        assert_eq!(outcome.amount_released, withdraw_amount);
        pool.enforce_invariant(&vault).expect("invariant");
    }

    #[test]
    fn private_transfer_requires_feature() {
        let vault = Vault::new(ORIGIN, POOL_AUTHORITY);
        let mut pool = PoolState::new(ORIGIN, POOL_AUTHORITY);
        let err = pool
            .private_transfer(&vault, &[nullifier(1)], &[note_id(1)], &[], root(2))
            .expect_err("feature disabled");
        assert_eq!(err, PoolError::FeatureDisabled("private_transfer"));
    }

    #[test]
    fn private_transfer_conserves_value() {
        let mut vault = Vault::new(ORIGIN, POOL_AUTHORITY);
        let mut pool = PoolState::new(ORIGIN, POOL_AUTHORITY);
        pool.set_features(FEATURE_PRIVATE_TRANSFER);
        pool.shield(&mut vault, 5_000, note_id(1), commitment(1), root(1))
            .expect("shield");
        let remaining_note = NoteCreation {
            id: note_id(2),
            commitment: commitment(2),
            amount: pool.live_notes_value(),
        };
        pool.private_transfer(
            &vault,
            &[nullifier(1)],
            &[note_id(1)],
            &[remaining_note],
            root(2),
        )
        .expect("transfer");
        assert!(pool.notes.contains_key(&note_id(2)));
        assert_eq!(
            pool.live_notes_value(),
            vault.balance() - pool.fees_collected()
        );
    }

    #[test]
    fn unshield_to_ptkn_increases_supply() {
        let vault = &mut Vault::new(ORIGIN, POOL_AUTHORITY);
        let mut pool = PoolState::new(ORIGIN, POOL_AUTHORITY);
        pool.shield(vault, 20_000, note_id(1), commitment(1), root(1))
            .expect("shield");
        let credited = pool.notes.get(&note_id(1)).unwrap().amount;
        let fee = pool.calculate_fee(19_000).unwrap();
        let change = credited - 19_000 - fee;
        let change_note = if change > 0 {
            vec![NoteCreation {
                id: note_id(7),
                commitment: commitment(7),
                amount: change,
            }]
        } else {
            Vec::new()
        };
        let outcome = pool
            .unshield_to_ptkn(
                vault,
                &[nullifier(1)],
                &[note_id(1)],
                &change_note,
                19_000,
                DESTINATION,
                root(2),
            )
            .expect("unshield ptkn");
        assert_eq!(outcome.amount_released, 19_000);
        assert_eq!(pool.ptoken_supply, 19_000);
        pool.enforce_invariant(vault).expect("invariant");
    }

    #[test]
    fn nullifier_reuse_blocked() {
        let mut vault = Vault::new(ORIGIN, POOL_AUTHORITY);
        let mut pool = PoolState::new(ORIGIN, POOL_AUTHORITY);
        pool.shield(&mut vault, 8_000, note_id(1), commitment(1), root(1))
            .expect("shield");
        let first_note_amount = pool.notes.get(&note_id(1)).unwrap().amount;
        let first_fee = pool.calculate_fee(7_000).unwrap();
        let first_change = first_note_amount - 7_000 - first_fee;
        let first_change_note = if first_change > 0 {
            vec![NoteCreation {
                id: note_id(9),
                commitment: commitment(9),
                amount: first_change,
            }]
        } else {
            Vec::new()
        };
        pool.unshield_to_origin(
            &mut vault,
            &[nullifier(1)],
            &[note_id(1)],
            &first_change_note,
            7_000,
            DESTINATION,
            root(2),
        )
        .expect("unshield");
        pool.shield(&mut vault, 2_000, note_id(2), commitment(2), root(3))
            .expect("shield again");
        let credited = pool.notes.get(&note_id(2)).unwrap().amount;
        let fee = pool.calculate_fee(1_500).unwrap();
        let change = credited - 1_500 - fee;
        let change_note = if change > 0 {
            vec![NoteCreation {
                id: note_id(3),
                commitment: commitment(3),
                amount: change,
            }]
        } else {
            Vec::new()
        };
        let err = pool
            .unshield_to_origin(
                &mut vault,
                &[nullifier(1)],
                &[note_id(2)],
                &change_note,
                1_500,
                DESTINATION,
                root(4),
            )
            .expect_err("reuse");
        assert_eq!(err, PoolError::NullifierReuse);
    }

    #[test]
    fn hooks_disabled_error() {
        let mut vault = Vault::new(ORIGIN, POOL_AUTHORITY);
        let mut pool = PoolState::new(ORIGIN, POOL_AUTHORITY);
        pool.set_features(FEATURE_HOOKS);
        pool.shield(&mut vault, 3_000, note_id(1), commitment(1), root(1))
            .expect("shield");
        let credited = pool.notes.get(&note_id(1)).unwrap().amount;
        let fee = pool.calculate_fee(2_500).unwrap();
        let change = credited - 2_500 - fee;
        let change_note = if change > 0 {
            vec![NoteCreation {
                id: note_id(8),
                commitment: commitment(8),
                amount: change,
            }]
        } else {
            Vec::new()
        };
        let err = pool
            .unshield_to_ptkn(
                &vault,
                &[nullifier(1)],
                &[note_id(1)],
                &change_note,
                2_500,
                DESTINATION,
                root(2),
            )
            .expect_err("hooks disabled");
        assert_eq!(err, PoolError::HooksDisabled);
    }
}
