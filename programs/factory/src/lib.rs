//! Simplified model of the Privacy Twin Factory registry.

use std::collections::HashMap;
use std::error::Error;
use std::fmt;

use ptf_common::{FeatureFlags, Pubkey, FEE_BPS_DEFAULT, MAX_BPS};

/// Status of an origin mint mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MintStatus {
    /// Mint is active and usable by the pool/vault programs.
    Active,
    /// Mint is frozen by governance.
    Frozen,
}

/// Governance actions enforced through a timelock queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GovernanceAction {
    /// Update the default fee charged by new mint registrations.
    UpdateDefaultFeeBps(u16),
    /// Update the default feature flags assigned to new mint registrations.
    SetDefaultFeatures(FeatureFlags),
    /// Pause the factory, blocking new registrations and updates.
    Pause,
    /// Unpause the factory.
    Unpause,
    /// Update the timelock delay (in seconds) required for future actions.
    SetTimelockSeconds(u64),
}

/// Error type for factory operations.
#[derive(Debug, PartialEq, Eq)]
pub enum FactoryError {
    /// Attempted to register an origin mint that already exists.
    AlreadyRegistered,
    /// Attempted to operate on a mint that is unknown to the factory.
    MintNotFound,
    /// Enforced when governance has paused the factory.
    Paused,
    /// Enforced when attempting to enable a privacy twin without providing a mint.
    PtknMintMissing,
    /// Invalid fee configuration provided.
    InvalidFeeBps,
    /// Caller does not match the DAO authority.
    Unauthorized,
    /// The provided timestamp would overflow when applying the timelock.
    TimelockOverflow,
    /// The requested governance action is not yet ready for execution.
    ActionNotReady,
    /// Governance action with the supplied identifier does not exist.
    ActionNotFound,
}

impl fmt::Display for FactoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            FactoryError::AlreadyRegistered => "mint mapping already exists",
            FactoryError::MintNotFound => "mint mapping not found",
            FactoryError::Paused => "factory is paused",
            FactoryError::PtknMintMissing => "privacy twin mint is required",
            FactoryError::InvalidFeeBps => "fee bps must not exceed MAX_BPS",
            FactoryError::Unauthorized => "caller is not the DAO authority",
            FactoryError::TimelockOverflow => "timelock addition overflowed",
            FactoryError::ActionNotReady => "governance action not ready",
            FactoryError::ActionNotFound => "governance action not found",
        };
        write!(f, "{}", message)
    }
}

impl Error for FactoryError {}

/// Parameters describing how the factory should treat a specific origin mint.
#[derive(Debug, Clone)]
pub struct MintMapping {
    origin_mint: Pubkey,
    ptkn_mint: Option<Pubkey>,
    status: MintStatus,
    decimals: u8,
    enable_ptkn: bool,
    fee_bps_override: Option<u16>,
    feature_flags: FeatureFlags,
}

impl MintMapping {
    fn new(origin_mint: Pubkey, decimals: u8) -> Self {
        Self {
            origin_mint,
            ptkn_mint: None,
            status: MintStatus::Active,
            decimals,
            enable_ptkn: false,
            fee_bps_override: None,
            feature_flags: FeatureFlags::default(),
        }
    }

    /// Returns the effective fee basis points for this mint.
    pub fn effective_fee_bps(&self) -> u16 {
        self.fee_bps_override.unwrap_or(FEE_BPS_DEFAULT)
    }

    /// Returns the currently configured privacy twin mint, if any.
    pub fn ptkn_mint(&self) -> Option<Pubkey> {
        self.ptkn_mint
    }

    /// Returns whether the mapping is active.
    pub fn is_active(&self) -> bool {
        self.status == MintStatus::Active
    }

    /// Returns the decimals configured for the origin mint.
    pub fn decimals(&self) -> u8 {
        self.decimals
    }

    /// Returns the configured feature flags.
    pub fn feature_flags(&self) -> FeatureFlags {
        self.feature_flags
    }
}

#[derive(Debug, Clone)]
struct QueuedAction {
    id: u64,
    action: GovernanceAction,
    execute_after: u64,
}

/// Public representation of a queued governance action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedGovernanceAction {
    /// Unique identifier assigned to the action when queued.
    pub id: u64,
    /// The action that will be executed after the timelock expires.
    pub action: GovernanceAction,
    /// Unix timestamp after which the action becomes executable.
    pub execute_after: u64,
}

/// Global factory state storing mappings and governance settings.
#[derive(Debug)]
pub struct FactoryState {
    dao_authority: Pubkey,
    paused: bool,
    timelock_seconds: u64,
    mappings: HashMap<Pubkey, MintMapping>,
    default_features: FeatureFlags,
    default_fee_bps: u16,
    queued_actions: HashMap<u64, QueuedAction>,
    next_action_id: u64,
}

impl FactoryState {
    /// Constructs a new factory state with the supplied governance authority.
    pub fn new(dao_authority: Pubkey) -> Self {
        Self {
            dao_authority,
            paused: false,
            timelock_seconds: 0,
            mappings: HashMap::new(),
            default_features: FeatureFlags::default(),
            default_fee_bps: FEE_BPS_DEFAULT,
            queued_actions: HashMap::new(),
            next_action_id: 1,
        }
    }

    /// Returns whether the factory is currently paused.
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Returns the currently configured timelock delay.
    pub fn timelock_seconds(&self) -> u64 {
        self.timelock_seconds
    }

    fn ensure_not_paused(&self) -> Result<(), FactoryError> {
        if self.paused {
            Err(FactoryError::Paused)
        } else {
            Ok(())
        }
    }

    fn assert_dao(&self, caller: Pubkey) -> Result<(), FactoryError> {
        if caller == self.dao_authority {
            Ok(())
        } else {
            Err(FactoryError::Unauthorized)
        }
    }

    /// Registers a new origin mint with optional privacy twin support.
    pub fn register_mint(
        &mut self,
        origin_mint: Pubkey,
        decimals: u8,
        enable_ptkn: bool,
        ptkn_mint: Option<Pubkey>,
    ) -> Result<(), FactoryError> {
        self.ensure_not_paused()?;
        if self.mappings.contains_key(&origin_mint) {
            return Err(FactoryError::AlreadyRegistered);
        }
        if enable_ptkn && ptkn_mint.is_none() {
            return Err(FactoryError::PtknMintMissing);
        }

        let mut mapping = MintMapping::new(origin_mint, decimals);
        mapping.enable_ptkn = enable_ptkn;
        mapping.ptkn_mint = ptkn_mint;
        mapping.feature_flags = self.default_features;
        mapping.fee_bps_override = Some(self.default_fee_bps);
        self.mappings.insert(origin_mint, mapping);
        Ok(())
    }

    /// Updates configuration for an existing mint mapping.
    pub fn update_mint(
        &mut self,
        origin_mint: Pubkey,
        enable_ptkn: Option<bool>,
        ptkn_mint: Option<Pubkey>,
        fee_bps_override: Option<u16>,
        feature_flags: Option<FeatureFlags>,
    ) -> Result<(), FactoryError> {
        self.ensure_not_paused()?;
        let mapping = self
            .mappings
            .get_mut(&origin_mint)
            .ok_or(FactoryError::MintNotFound)?;

        if let Some(enable) = enable_ptkn {
            if enable && ptkn_mint.is_none() && mapping.ptkn_mint.is_none() {
                return Err(FactoryError::PtknMintMissing);
            }
            mapping.enable_ptkn = enable;
            if enable {
                if let Some(mint) = ptkn_mint.or(mapping.ptkn_mint) {
                    mapping.ptkn_mint = Some(mint);
                }
            }
        }

        if let Some(fee) = fee_bps_override {
            if fee > MAX_BPS {
                return Err(FactoryError::InvalidFeeBps);
            }
            mapping.fee_bps_override = Some(fee);
        }

        if let Some(flags) = feature_flags {
            mapping.feature_flags = flags;
        }

        Ok(())
    }

    /// Freezes a mint mapping, preventing new activity.
    pub fn freeze_mapping(&mut self, origin_mint: Pubkey) -> Result<(), FactoryError> {
        self.ensure_not_paused()?;
        let mapping = self
            .mappings
            .get_mut(&origin_mint)
            .ok_or(FactoryError::MintNotFound)?;
        mapping.status = MintStatus::Frozen;
        Ok(())
    }

    /// Re-activates a previously frozen mint mapping.
    pub fn thaw_mapping(&mut self, origin_mint: Pubkey) -> Result<(), FactoryError> {
        self.ensure_not_paused()?;
        let mapping = self
            .mappings
            .get_mut(&origin_mint)
            .ok_or(FactoryError::MintNotFound)?;
        mapping.status = MintStatus::Active;
        Ok(())
    }

    /// Globally pauses the factory (DAO only).
    pub fn pause(&mut self, caller: Pubkey) -> Result<(), FactoryError> {
        self.assert_dao(caller)?;
        self.paused = true;
        Ok(())
    }

    /// Resumes normal operation for the factory (DAO only).
    pub fn unpause(&mut self, caller: Pubkey) -> Result<(), FactoryError> {
        self.assert_dao(caller)?;
        self.paused = false;
        Ok(())
    }

    /// Queues a governance action for future execution once the timelock expires.
    pub fn queue_action(
        &mut self,
        caller: Pubkey,
        action: GovernanceAction,
        current_time: u64,
    ) -> Result<u64, FactoryError> {
        self.assert_dao(caller)?;
        let execute_after = current_time
            .checked_add(self.timelock_seconds)
            .ok_or(FactoryError::TimelockOverflow)?;
        let id = self.next_action_id;
        self.next_action_id = self
            .next_action_id
            .checked_add(1)
            .expect("action ids overflowed");
        let queued = QueuedAction {
            id,
            action,
            execute_after,
        };
        self.queued_actions.insert(id, queued);
        Ok(id)
    }

    /// Executes a previously queued action when the timelock has elapsed.
    pub fn execute_action(
        &mut self,
        caller: Pubkey,
        action_id: u64,
        current_time: u64,
    ) -> Result<(), FactoryError> {
        self.assert_dao(caller)?;
        let queued = self
            .queued_actions
            .get(&action_id)
            .ok_or(FactoryError::ActionNotFound)?;
        if current_time < queued.execute_after {
            return Err(FactoryError::ActionNotReady);
        }
        let action = queued.action.clone();
        self.queued_actions.remove(&action_id);
        self.apply_action(action)
    }

    /// Returns metadata about a queued governance action, if present.
    pub fn queued_action(&self, action_id: u64) -> Option<QueuedGovernanceAction> {
        self.queued_actions.get(&action_id).map(|queued| QueuedGovernanceAction {
            id: queued.id,
            action: queued.action.clone(),
            execute_after: queued.execute_after,
        })
    }

    fn apply_action(&mut self, action: GovernanceAction) -> Result<(), FactoryError> {
        match action {
            GovernanceAction::UpdateDefaultFeeBps(bps) => {
                if bps > MAX_BPS {
                    return Err(FactoryError::InvalidFeeBps);
                }
                self.default_fee_bps = bps;
            }
            GovernanceAction::SetDefaultFeatures(flags) => {
                self.default_features = flags;
            }
            GovernanceAction::Pause => {
                self.paused = true;
            }
            GovernanceAction::Unpause => {
                self.paused = false;
            }
            GovernanceAction::SetTimelockSeconds(seconds) => {
                self.timelock_seconds = seconds;
            }
        }
        Ok(())
    }

    /// Fetches a copy of the requested mint mapping.
    pub fn mapping(&self, origin_mint: &Pubkey) -> Option<&MintMapping> {
        self.mappings.get(origin_mint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ptf_common::FEATURE_PRIVATE_TRANSFER;

    const DAO: Pubkey = Pubkey::new([9u8; 32]);
    const MINT_A: Pubkey = Pubkey::new([1u8; 32]);
    const PTKN_A: Pubkey = Pubkey::new([2u8; 32]);
    const NOT_DAO: Pubkey = Pubkey::new([3u8; 32]);

    #[test]
    fn register_new_mint() {
        let mut factory = FactoryState::new(DAO);
        factory
            .register_mint(MINT_A, 6, false, None)
            .expect("register");
        let mapping = factory.mapping(&MINT_A).unwrap();
        assert_eq!(mapping.decimals(), 6);
        assert_eq!(mapping.ptkn_mint(), None);
        assert!(mapping.is_active());
        assert_eq!(mapping.effective_fee_bps(), FEE_BPS_DEFAULT);
    }

    #[test]
    fn register_with_ptkn_requires_mint() {
        let mut factory = FactoryState::new(DAO);
        let err = factory
            .register_mint(MINT_A, 6, true, None)
            .expect_err("missing ptkn");
        assert_eq!(err, FactoryError::PtknMintMissing);
    }

    #[test]
    fn update_existing_mint_enables_ptkn() {
        let mut factory = FactoryState::new(DAO);
        factory
            .register_mint(MINT_A, 9, false, None)
            .expect("register");
        factory
            .update_mint(MINT_A, Some(true), Some(PTKN_A), Some(12), None)
            .expect("update");
        let mapping = factory.mapping(&MINT_A).unwrap();
        assert_eq!(mapping.ptkn_mint(), Some(PTKN_A));
        assert_eq!(mapping.effective_fee_bps(), 12);
    }

    #[test]
    fn freeze_and_thaw_mapping() {
        let mut factory = FactoryState::new(DAO);
        factory
            .register_mint(MINT_A, 6, false, None)
            .expect("register");
        factory.freeze_mapping(MINT_A).expect("freeze");
        assert_eq!(factory.mapping(&MINT_A).unwrap().is_active(), false);
        factory.thaw_mapping(MINT_A).expect("thaw");
        assert_eq!(factory.mapping(&MINT_A).unwrap().is_active(), true);
    }

    #[test]
    fn pause_blocks_mutations() {
        let mut factory = FactoryState::new(DAO);
        factory.pause(DAO).expect("pause");
        let err = factory
            .register_mint(MINT_A, 6, false, None)
            .expect_err("paused");
        assert_eq!(err, FactoryError::Paused);
        factory.unpause(DAO).expect("unpause");
        factory
            .register_mint(MINT_A, 6, false, None)
            .expect("register");
    }

    #[test]
    fn pause_requires_dao() {
        let mut factory = FactoryState::new(DAO);
        let err = factory.pause(NOT_DAO).expect_err("unauthorized");
        assert_eq!(err, FactoryError::Unauthorized);
    }

    #[test]
    fn update_rejects_invalid_fee() {
        let mut factory = FactoryState::new(DAO);
        factory
            .register_mint(MINT_A, 6, false, None)
            .expect("register");
        let err = factory
            .update_mint(MINT_A, None, None, Some(MAX_BPS + 1), None)
            .expect_err("invalid fee");
        assert_eq!(err, FactoryError::InvalidFeeBps);
    }

    #[test]
    fn queue_and_execute_fee_update() {
        let mut factory = FactoryState::new(DAO);
        factory
            .register_mint(MINT_A, 6, false, None)
            .expect("register");
        factory
            .queue_action(DAO, GovernanceAction::SetTimelockSeconds(10), 0)
            .expect("queue timelock");
        factory
            .execute_action(DAO, 1, 0)
            .expect("execute timelock change");
        assert_eq!(factory.timelock_seconds(), 10);
        let action_id = factory
            .queue_action(DAO, GovernanceAction::UpdateDefaultFeeBps(25), 5)
            .expect("queue fee update");
        let err = factory
            .execute_action(DAO, action_id, 10)
            .expect_err("not ready");
        assert_eq!(err, FactoryError::ActionNotReady);
        factory
            .execute_action(DAO, action_id, 15)
            .expect("execute fee update");
        factory
            .register_mint(PTKN_A, 6, false, None)
            .expect("second register");
        let mapping = factory.mapping(&PTKN_A).unwrap();
        assert_eq!(mapping.effective_fee_bps(), 25);
    }

    #[test]
    fn queue_action_metadata_visible() {
        let mut factory = FactoryState::new(DAO);
        let action_id = factory
            .queue_action(DAO, GovernanceAction::Pause, 42)
            .expect("queue");
        let queued = factory.queued_action(action_id).expect("action exists");
        assert_eq!(queued.id, action_id);
        assert_eq!(queued.action, GovernanceAction::Pause);
        assert_eq!(queued.execute_after, 42);
    }

    #[test]
    fn governance_updates_default_features() {
        let mut factory = FactoryState::new(DAO);
        let timelock_id = factory
            .queue_action(DAO, GovernanceAction::SetTimelockSeconds(5), 0)
            .expect("queue timelock");
        factory
            .execute_action(DAO, timelock_id, 0)
            .expect("apply timelock");

        let action_id = factory
            .queue_action(DAO, GovernanceAction::SetDefaultFeatures(FEATURE_PRIVATE_TRANSFER), 3)
            .expect("queue features");
        let queued = factory.queued_action(action_id).expect("queued metadata");
        assert_eq!(queued.execute_after, 8);

        let err = factory
            .execute_action(DAO, action_id, 7)
            .expect_err("timelock not expired");
        assert_eq!(err, FactoryError::ActionNotReady);

        factory
            .execute_action(DAO, action_id, 8)
            .expect("execute features update");
        factory
            .register_mint(MINT_A, 6, false, None)
            .expect("register after update");
        let mapping = factory.mapping(&MINT_A).unwrap();
        assert_eq!(mapping.feature_flags(), FEATURE_PRIVATE_TRANSFER);
    }

    #[test]
    fn unauthorized_queue_rejected() {
        let mut factory = FactoryState::new(DAO);
        let err = factory
            .queue_action(NOT_DAO, GovernanceAction::Pause, 0)
            .expect_err("unauthorized");
        assert_eq!(err, FactoryError::Unauthorized);
    }

    #[test]
    fn executing_missing_action_errors() {
        let mut factory = FactoryState::new(DAO);
        let err = factory
            .execute_action(DAO, 42, 0)
            .expect_err("missing action");
        assert_eq!(err, FactoryError::ActionNotFound);
    }
}
