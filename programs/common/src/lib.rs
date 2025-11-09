//! Common constants, helpers, and shared types for the Privacy Twin Factory programs.

use anchor_lang::prelude::*;
use thiserror::Error;

/// Depth of the Merkle tree used by shielded pools.
pub const MERKLE_DEPTH: u8 = 32;
/// Default basis points fee applied to shield and unshield operations.
pub const FEE_BPS_DEFAULT: u16 = 5;
/// Feature flag enabling private in-pool transfers.
pub const FEATURE_PRIVATE_TRANSFER_ENABLED: u8 = 0x01;
/// Feature flag enabling hook CPIs.
pub const FEATURE_HOOKS_ENABLED: u8 = 0x02;
/// Maximum basis points value accepted by the protocol (100%).
pub const MAX_BPS: u16 = 10_000;

/// Prefix seeds used across PDAs.
pub mod seeds {
    pub const FACTORY: &[u8] = b"factory";
    pub const MINT_MAPPING: &[u8] = b"map";
    pub const VAULT: &[u8] = b"vault";
    pub const POOL: &[u8] = b"pool";
    pub const HOOKS: &[u8] = b"hooks";
    pub const VERIFIER: &[u8] = b"vk";
    pub const NULLIFIERS: &[u8] = b"nulls";
}

/// Runtime feature flags represented as a bit field.
#[derive(Clone, Copy, Debug, Default, AnchorSerialize, AnchorDeserialize, Eq, PartialEq)]
pub struct FeatureFlags(u8);

impl FeatureFlags {
    /// Constructs an empty set of flags.
    pub const fn empty() -> Self {
        Self(0)
    }

    /// Creates flags from raw bits.
    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    /// Returns the raw bits.
    pub const fn bits(self) -> u8 {
        self.0
    }

    /// Returns `true` if all bits in `other` are contained in `self`.
    pub const fn contains(self, other: FeatureFlags) -> bool {
        (self.0 & other.0) == other.0
    }

    /// Sets the provided flag bits.
    pub fn insert(&mut self, other: FeatureFlags) {
        self.0 |= other.0;
    }

    /// Removes the provided flag bits.
    pub fn remove(&mut self, other: FeatureFlags) {
        self.0 &= !other.0;
    }
}

impl From<u8> for FeatureFlags {
    fn from(value: u8) -> FeatureFlags {
        FeatureFlags::from_bits(value)
    }
}

impl From<FeatureFlags> for u8 {
    fn from(value: FeatureFlags) -> u8 {
        value.bits()
    }
}

impl core::fmt::Display for FeatureFlags {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "0x{:02x}", self.0)
    }
}

/// Shared protocol errors that are surfaced across programs.
#[derive(Error, Debug)]
pub enum ProtocolError {
    /// Attempted to mutate a mapping while the protocol is paused.
    #[error("protocol paused")]
    Paused,
    /// Attempted to enable a feature that is not compiled into the current build.
    #[error("feature unavailable in current build profile")]
    FeatureUnavailable,
    /// Invalid fee configuration.
    #[error("invalid fee basis points")]
    InvalidFee,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_flag_combinations() {
        let mut flags = FeatureFlags::from_bits(FEATURE_PRIVATE_TRANSFER_ENABLED);
        assert!(flags.contains(FeatureFlags::from_bits(FEATURE_PRIVATE_TRANSFER_ENABLED)));
        flags.insert(FeatureFlags::from_bits(FEATURE_HOOKS_ENABLED));
        assert!(flags.contains(FeatureFlags::from_bits(FEATURE_HOOKS_ENABLED)));
        flags.remove(FeatureFlags::from_bits(FEATURE_HOOKS_ENABLED));
        assert!(!flags.contains(FeatureFlags::from_bits(FEATURE_HOOKS_ENABLED)));
    }
}
