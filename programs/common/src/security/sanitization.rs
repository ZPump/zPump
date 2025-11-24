//! Input sanitization layer for proofs, commitments, and other inputs.

use anchor_lang::prelude::*;
use super::errors::CommonError;

/// Maximum proof size (100KB)
pub const MAX_PROOF_SIZE: usize = 100 * 1024;

/// Maximum public inputs size (10KB)
pub const MAX_PUBLIC_INPUTS_SIZE: usize = 10 * 1024;

/// Centralized input sanitization.
pub struct InputSanitizer;

impl InputSanitizer {
    /// Sanitize and validate proof.
    pub fn sanitize_proof(proof: &[u8], max_size: usize) -> Result<&[u8]> {
        require!(
            proof.len() <= max_size,
            CommonError::ProofTooLarge
        );
        require!(!proof.is_empty(), CommonError::InvalidProof);
        Ok(proof)
    }
    
    /// Sanitize and validate public inputs.
    pub fn sanitize_public_inputs(
        inputs: &[u8],
        max_size: usize,
    ) -> Result<&[u8]> {
        require!(
            inputs.len() <= max_size,
            CommonError::PublicInputsTooLarge
        );
        require!(!inputs.is_empty(), CommonError::InvalidPublicInputs);
        Ok(inputs)
    }
    
    /// Sanitize commitment (validate format).
    pub fn sanitize_commitment(commitment: &[u8; 32]) -> Result<()> {
        // Reject all zeros
        require!(
            *commitment != [0u8; 32],
            CommonError::InvalidCommitment
        );
        // Reject all ones (invalid field element)
        require!(
            *commitment != [0xFFu8; 32],
            CommonError::InvalidCommitment
        );
        Ok(())
    }
    
    /// Sanitize nullifier.
    pub fn sanitize_nullifier(nullifier: &[u8; 32]) -> Result<()> {
        // Same validation as commitment
        Self::sanitize_commitment(nullifier)
    }
}

