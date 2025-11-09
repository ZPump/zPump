//! Common types and constants shared across the Privacy Twin Factory workspace.

use std::{
    fmt,
    hash::{Hash, Hasher},
};

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

/// Lightweight replacement for Solana's `Pubkey`.
#[derive(Clone, Copy, Default)]
pub struct Pubkey([u8; 32]);

impl Pubkey {
    /// Creates a new public key from raw bytes.
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Returns the underlying bytes.
    pub const fn to_bytes(self) -> [u8; 32] {
        self.0
    }
}

impl PartialEq for Pubkey {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Eq for Pubkey {}

impl Hash for Pubkey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write(&self.0);
    }
}

impl fmt::Debug for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Pubkey({:02x?})", self.0)
    }
}

impl fmt::Display for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in &self.0 {
            write!(f, "{:02x}", byte)?;
        }
        Ok(())
    }
}

/// Runtime feature flags represented as a bit field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

impl Default for FeatureFlags {
    fn default() -> Self {
        FeatureFlags::empty()
    }
}

impl fmt::Display for FeatureFlags {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "0x{:02x}", self.0)
    }
}

/// Convenience constructors for individual feature bits.
pub const FEATURE_PRIVATE_TRANSFER: FeatureFlags = FeatureFlags(FEATURE_PRIVATE_TRANSFER_ENABLED);
pub const FEATURE_HOOKS: FeatureFlags = FeatureFlags(FEATURE_HOOKS_ENABLED);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pubkey_display_hex_roundtrip() {
        let bytes = [0x11u8; 32];
        let pk = Pubkey::new(bytes);
        assert_eq!(pk.to_string(), "11".repeat(32));
        assert_eq!(pk, Pubkey::new(bytes));
    }

    #[test]
    fn feature_flag_combinations() {
        let mut flags = FeatureFlags::from_bits(FEATURE_PRIVATE_TRANSFER_ENABLED);
        assert!(flags.contains(FEATURE_PRIVATE_TRANSFER));
        flags.insert(FEATURE_HOOKS);
        assert!(flags.contains(FEATURE_HOOKS));
        flags.remove(FEATURE_HOOKS);
        assert!(!flags.contains(FEATURE_HOOKS));
    }
}
