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
}

impl fmt::Display for FactoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            FactoryError::AlreadyRegistered => "mint mapping already exists",
            FactoryError::MintNotFound => "mint mapping not found",
            FactoryError::Paused => "factory is paused",
            FactoryError::PtknMintMissing => "privacy twin mint is required",
            FactoryError::InvalidFeeBps => "fee bps must not exceed MAX_BPS",
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

/// Global factory state storing mappings and governance settings.
#[derive(Debug)]
pub struct FactoryState {
    dao_authority: Pubkey,
    paused: bool,
    mappings: HashMap<Pubkey, MintMapping>,
    default_features: FeatureFlags,
    default_fee_bps: u16,
}

impl FactoryState {
    /// Constructs a new factory state with the supplied governance authority.
    pub fn new(dao_authority: Pubkey) -> Self {
        Self {
            dao_authority,
            paused: false,
            mappings: HashMap::new(),
            default_features: FeatureFlags::default(),
            default_fee_bps: FEE_BPS_DEFAULT,
        }
    }

    /// Returns whether the factory is currently paused.
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    fn ensure_not_paused(&self) -> Result<(), FactoryError> {
        if self.paused {
            Err(FactoryError::Paused)
        } else {
            Ok(())
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

    /// Globally pauses the factory.
    pub fn pause(&mut self) {
        self.paused = true;
    }

    /// Resumes normal operation for the factory.
    pub fn unpause(&mut self) {
        self.paused = false;
    }

    /// Fetches a copy of the requested mint mapping.
    pub fn mapping(&self, origin_mint: &Pubkey) -> Option<&MintMapping> {
        self.mappings.get(origin_mint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAO: Pubkey = Pubkey::new([9u8; 32]);
    const MINT_A: Pubkey = Pubkey::new([1u8; 32]);
    const PTKN_A: Pubkey = Pubkey::new([2u8; 32]);

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
        factory.pause();
        let err = factory
            .register_mint(MINT_A, 6, false, None)
            .expect_err("paused");
        assert_eq!(err, FactoryError::Paused);
        factory.unpause();
        factory
            .register_mint(MINT_A, 6, false, None)
            .expect("register");
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
}
