//! Groth16 verifier stub that checks deterministic digests without external crates.

use std::collections::HashMap;
use std::error::Error;
use std::fmt;

/// Errors returned by the verifier module.
#[derive(Debug, PartialEq, Eq)]
pub enum VerifierError {
    KeyAlreadyExists,
    KeyNotFound,
    VerificationFailed,
}

impl fmt::Display for VerifierError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VerifierError::KeyAlreadyExists => write!(f, "verifying key already exists"),
            VerifierError::KeyNotFound => write!(f, "verifying key not found"),
            VerifierError::VerificationFailed => write!(f, "proof verification failed"),
        }
    }
}

impl Error for VerifierError {}

/// Metadata stored for a Groth16 verifying key.
#[derive(Debug, Clone)]
pub struct VerifyingKey {
    circuit_id: String,
    version: String,
    vk_hash: [u8; 32],
    expected_statement_hash: [u8; 32],
}

impl VerifyingKey {
    /// Creates a new verifying key, hashing the provided raw bytes.
    pub fn new(
        circuit_id: impl Into<String>,
        version: impl Into<String>,
        raw_bytes: &[u8],
        expected_statement_hash: [u8; 32],
    ) -> Self {
        let vk_hash = simple_hash(raw_bytes);
        Self {
            circuit_id: circuit_id.into(),
            version: version.into(),
            vk_hash,
            expected_statement_hash,
        }
    }

    /// Returns the hash of the verifying key bytes.
    pub fn hash(&self) -> [u8; 32] {
        self.vk_hash
    }
}

/// Registry and verifier implementation.
#[derive(Debug, Default)]
pub struct Verifier {
    keys: HashMap<String, VerifyingKey>,
}

impl Verifier {
    /// Registers a verifying key. Keys are immutable and cannot be replaced.
    pub fn register(
        &mut self,
        id: impl Into<String>,
        key: VerifyingKey,
    ) -> Result<(), VerifierError> {
        let id = id.into();
        if self.keys.contains_key(&id) {
            return Err(VerifierError::KeyAlreadyExists);
        }
        self.keys.insert(id, key);
        Ok(())
    }

    /// Verifies a proof against the stored digest.
    pub fn verify(
        &self,
        id: &str,
        proof_bytes: &[u8],
        public_inputs: &[u8],
    ) -> Result<(), VerifierError> {
        let key = self.keys.get(id).ok_or(VerifierError::KeyNotFound)?;
        let mut concatenated = Vec::with_capacity(proof_bytes.len() + public_inputs.len());
        concatenated.extend_from_slice(proof_bytes);
        concatenated.extend_from_slice(public_inputs);
        let computed = simple_hash(&concatenated);
        if computed == key.expected_statement_hash {
            Ok(())
        } else {
            Err(VerifierError::VerificationFailed)
        }
    }
}

fn simple_hash(data: &[u8]) -> [u8; 32] {
    // FNV-1a based mixer expanded to 32 bytes.
    let mut result = [0u8; 32];
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut offset = 0usize;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
        let chunk = hash.to_le_bytes();
        let start = (offset % 4) * 8;
        for i in 0..8 {
            result[start + i] ^= chunk[i];
        }
        offset += 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(proof: &[u8], inputs: &[u8]) -> [u8; 32] {
        let mut concatenated = Vec::with_capacity(proof.len() + inputs.len());
        concatenated.extend_from_slice(proof);
        concatenated.extend_from_slice(inputs);
        simple_hash(&concatenated)
    }

    #[test]
    fn register_and_verify_success() {
        let proof = b"proof";
        let inputs = b"inputs";
        let expected = digest(proof, inputs);
        let key = VerifyingKey::new("shield", "1.0", b"vk-bytes", expected);
        let mut verifier = Verifier::default();
        verifier.register("shield", key).expect("register");
        verifier.verify("shield", proof, inputs).expect("verify");
    }

    #[test]
    fn registering_duplicate_key_fails() {
        let expected = digest(b"proof", b"inputs");
        let key = VerifyingKey::new("unshield", "1.0", b"vk", expected);
        let mut verifier = Verifier::default();
        verifier
            .register("unshield", key.clone())
            .expect("register");
        let err = verifier.register("unshield", key).expect_err("duplicate");
        assert_eq!(err, VerifierError::KeyAlreadyExists);
    }

    #[test]
    fn verification_failure_detected() {
        let expected = digest(b"proof", b"inputs");
        let key = VerifyingKey::new("transfer", "1.0", b"vk", expected);
        let mut verifier = Verifier::default();
        verifier.register("transfer", key).expect("register");
        let err = verifier
            .verify("transfer", b"bad-proof", b"inputs")
            .expect_err("invalid proof");
        assert_eq!(err, VerifierError::VerificationFailed);
    }

    #[test]
    fn missing_key_detected() {
        let verifier = Verifier::default();
        let err = verifier
            .verify("shield", b"proof", b"inputs")
            .expect_err("missing key");
        assert_eq!(err, VerifierError::KeyNotFound);
    }
}
