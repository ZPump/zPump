/**
 * Centralized error handling for standardized Anchor program errors.
 * 
 * Maps standardized error messages from programs to user-friendly messages
 * and provides utilities for error parsing and normalization.
 */

import { SendTransactionError } from '@solana/web3.js';

/**
 * Standardized error message mappings from programs to user-friendly messages.
 * These correspond to the error messages defined in programs/common/src/security/errors.rs
 */
export const ERROR_MESSAGES: Record<string, string> = {
  // Validation errors
  'Invalid account owner': 'The account is not owned by the expected program. Please verify the account address.',
  'Account data too short': 'Account data is corrupted or incomplete. Please try again or contact support.',
  'Invalid PDA': 'Invalid program-derived address. Please verify the account derivation.',
  'Invalid bump seed': 'Invalid bump seed for PDA derivation. Please verify the account.',
  'Invalid discriminator': 'Account discriminator mismatch. The account may be of the wrong type.',
  'Account data corrupt': 'Account data is corrupted. Please try again or contact support.',
  'Account size mismatch': 'Account size does not match expected size. Please verify the account.',
  'Data length mismatch': 'Data length mismatch. Please verify the transaction parameters.',
  
  // Input errors
  'Invalid amount': 'The amount is invalid. Please enter a valid amount greater than zero.',
  'Amount too large': 'The amount exceeds the maximum allowed. Please reduce the amount.',
  'Amount overflow': 'Amount calculation overflow. Please reduce the amount.',
  'Invalid fee basis points': 'Invalid fee configuration. Please contact support.',
  'Invalid pubkey': 'Invalid public key. Please verify the address.',
  'Invalid mint': 'Invalid mint address. Please select a valid token.',
  'Invalid decimals': 'Invalid decimal configuration. Please contact support.',
  'Invalid destination': 'Invalid destination address. Please verify the recipient address.',
  
  // Access control errors
  'Unauthorized': 'You are not authorized to perform this action.',
  'Unauthorized caller': 'You are not authorized to call this instruction.',
  'Insufficient signatures': 'Insufficient signatures for multi-sig operation.',
  'Duplicate signer': 'Duplicate signer detected in multi-sig operation.',
  'Invalid authority': 'Invalid authority for this operation.',
  
  // State errors
  'Invalid state transition': 'Invalid state transition. The operation cannot be performed in the current state.',
  'State machine error': 'State machine error. Please try again.',
  'Already initialized': 'Account is already initialized.',
  'Already executed': 'This action has already been executed.',
  'Already canceled': 'This action has already been canceled.',
  'Change canceled': 'The proposed change has been canceled.',
  
  // Rate limiting errors
  'Rate limited': 'Rate limit exceeded. Please wait before trying again.',
  'Action rate limit exceeded': 'Action rate limit exceeded. Please wait before trying again.',
  'Global action rate limit exceeded': 'Global action rate limit exceeded. Please wait before trying again.',
  
  // Integrity errors
  'Integrity check failed': 'Account integrity check failed. The account may have been tampered with.',
  'Hash mismatch': 'Hash mismatch detected. Please verify the data.',
  'Stale proposal': 'This proposal is stale and cannot be executed.',
  'Authority mismatch': 'Authority mismatch. Please verify the authority.',
  
  // Invariant errors
  'Invariant breach': 'System invariant breach detected. Please contact support.',
  
  // Sanitization errors
  'Invalid proof': 'Invalid zero-knowledge proof. Please regenerate the proof.',
  'Proof too large': 'Proof exceeds maximum size. Please contact support.',
  'Invalid proof format': 'Invalid proof format. Please regenerate the proof.',
  'Invalid public inputs': 'Invalid public inputs for the proof. Please verify the inputs.',
  'Public inputs too large': 'Public inputs exceed maximum size. Please reduce the inputs.',
  'Public input mismatch': 'Public input mismatch. Please verify the proof inputs.',
  'Invalid commitment': 'Invalid commitment format. Please verify the commitment.',
  'Invalid nullifier': 'Invalid nullifier format. Please verify the nullifier.',
  'Nullifier reuse': 'This nullifier has already been used. Double-spending is not allowed.',
  
  // Timelock errors
  'Timelock overflow': 'Timelock calculation overflow. Please contact support.',
  'Timelock not ready': 'Timelock period has not elapsed. Please wait before executing.',
  'Timelock not expired': 'Timelock has not expired yet. Please wait.',
  'Change expired': 'The proposed change has expired and can no longer be executed.',
  'Change not expired': 'The change has not expired yet.',
  
  // Sequence/overflow errors
  'Sequence overflow': 'Sequence number overflow. Please contact support.',
  
  // Reentrancy errors
  'Reentrancy detected': 'Reentrancy attack detected. The operation cannot be completed.',
  
  // Insufficient balance/liability errors
  'Insufficient balance': 'Insufficient balance to complete this operation.',
  'Insufficient liquidity': 'Insufficient liquidity in the pool. Please try a smaller amount.',
  'Insufficient fees': 'Insufficient fees to complete this operation.',
  
  // Program-specific errors (Pool)
  'Pool already initialized': 'Pool is already initialized.',
  'Verifier mismatch': 'Verifier program mismatch. Please contact support.',
  'Invalid field element': 'Invalid field element in proof. Please regenerate the proof.',
  'Unknown root': 'Unknown commitment tree root. Please verify the root.',
  'Feature disabled': 'This feature is currently disabled.',
  'Mint frozen': 'This mint is currently frozen by governance. Please select a different token or wait until it is thawed.',
  'Shield finalization required': 'Shield finalization is required before proceeding.',
  'Vault authority mismatch': 'Vault authority mismatch. Please verify the vault.',
  'Origin mint mismatch': 'Origin mint mismatch. Please verify the mint.',
  'Mint mapping corrupt': 'Mint mapping is corrupted. Please contact support.',
  'Vault token account mismatch': 'Vault token account mismatch. Please verify the account.',
  'Invalid depositor account': 'Invalid depositor account. Please verify the account.',
  'Twin mint mismatch': 'Twin mint mismatch. Please verify the mint configuration.',
  'Twin mint not configured': 'Twin mint is not configured for this pool.',
  'Twin mint authority mismatch': 'Twin mint authority mismatch. Please verify the authority.',
  'Twin mint decimals mismatch': 'Twin mint decimals mismatch. Please verify the configuration.',
  'Hooks disabled': 'Hooks are disabled for this operation.',
  'Too many hook accounts': 'Too many hook accounts provided.',
  'Hook config invalid': 'Invalid hook configuration.',
  'Hook account mismatch': 'Hook account mismatch. Please verify the account.',
  'Hook account missing': 'Required hook account is missing.',
  'Hook account unexpected': 'Unexpected hook account provided.',
  'Note ledger mismatch': 'Note ledger mismatch. Please verify the ledger.',
  'Tree mismatch': 'Commitment tree mismatch. Please verify the tree.',
  'Invalid change note count': 'Invalid change note count. Please verify the transaction.',
  'Output set mismatch': 'Output set mismatch. Please verify the outputs.',
  'Canopy depth invalid': 'Invalid canopy depth. Please contact support.',
  'Tree full': 'Commitment tree is full. Please contact support.',
  'Root mismatch': 'Root mismatch detected. Please refresh and try again.',
  'Root drift': 'Root drift detected. Please refresh and try again.',
  'Pending shield in flight': 'A shield operation is already in progress. Please wait for it to complete.',
  'No pending shield': 'No pending shield operation found.',
  'Pending shield mismatch': 'Pending shield mismatch. Please refresh and try again.',
  'Shield finalize missing': 'Shield finalization is missing. Please finalize the shield first.',
  'Shield claim mismatch': 'Shield claim mismatch. Please verify the claim.',
  'Shield claim stage': 'Invalid shield claim stage. Please verify the claim state.',
  'Allowance pool mismatch': 'Allowance pool mismatch. Please verify the allowance.',
  'Allowance owner mismatch': 'Allowance owner mismatch. Please verify the allowance.',
  'Allowance spender mismatch': 'Allowance spender mismatch. Please verify the allowance.',
  'Allowance mint mismatch': 'Allowance mint mismatch. Please verify the allowance.',
  'Allowance insufficient': 'Insufficient allowance for this operation.',
  'Allowance amount invalid': 'Invalid allowance amount. Please verify the amount.',
  'Allowance amount mismatch': 'Allowance amount mismatch. Please verify the amount.',
  'Allowance too large': 'Allowance amount exceeds maximum allowed.',
  'Allowance expired': 'This allowance has expired and can no longer be used.',
  'Invalid expiration': 'Invalid expiration time. Please verify the expiration.',
  'Nullifier set mismatch': 'Nullifier set mismatch. Please verify the nullifiers.',
  'Hook not whitelisted': 'Hook program is not whitelisted.',
  'Hook execution failed': 'Hook execution failed. Please verify the hook configuration.',
  'Hook already whitelisted': 'Hook program is already whitelisted.',
  'Whitelist full': 'Hook whitelist is full. Please remove a hook before adding a new one.',
  
  // Program-specific errors (Vault)
  'Invalid vault account': 'Invalid vault account. Please verify the account.',
  'Invalid token program': 'Invalid token program. Please verify the program.',
  'Invalid pool authority': 'Invalid pool authority. Please verify the authority.',
  'Pending change exists': 'A pending authority change already exists. Please wait for it to complete or cancel it first.',
  'Authority change rate limited': 'Authority changes are rate limited. Please wait before proposing another change.',
  'Vault mismatch': 'Vault mismatch. Please verify the vault.',
  'Invalid authority change': 'Invalid authority change. Please verify the new authority.',
  
  // Program-specific errors (Factory)
  'Already registered': 'This mint is already registered.',
  'Factory paused': 'Factory is currently paused. Please wait until it is unpaused.',
  'Factory not paused': 'Factory is not paused.',
  'PTKN mint missing': 'PTKN mint is missing. Please verify the configuration.',
  'PTKN mint mismatch': 'PTKN mint mismatch. Please verify the mint.',
  'PTKN authority missing': 'PTKN authority is missing. Please verify the configuration.',
  'Token program missing': 'Token program is missing. Please verify the configuration.',
  'Rent missing': 'Insufficient rent for account creation. Please add more SOL.',
  'PTKN payer missing': 'PTKN payer is missing. Please verify the configuration.',
  'PTKN mint disabled': 'PTKN mint is disabled. Please contact support.',
  'Pool authority mismatch': 'Pool authority mismatch. Please verify the authority.',
  'Timelock consumed': 'Timelock entry has already been consumed.',
  'Timelock mint mapping missing': 'Timelock mint mapping is missing. Please verify the configuration.',
  'Timelock invalid factory': 'Invalid factory for timelock operation.',
  'Timelock only queue': 'Timelock operation can only be queued.',
  'Serialization error': 'Serialization error. Please try again.',
  'Emergency pause not configured': 'Emergency pause is not configured.',
  'Insufficient emergency signatures': 'Insufficient emergency signatures for pause operation.',
  'Timelock hash mismatch': 'Timelock hash mismatch. Please verify the hash.',
  'Verifying key hash mismatch': 'Verifying key hash mismatch. Please verify the key.',
  'Verifying key too large': 'Verifying key exceeds maximum size.',
  'Duplicate action': 'Duplicate action detected. This action has already been queued.',
  'Too many pending actions': 'Too many pending actions. Please wait for some to complete.',
  'Action expired': 'This action has expired and can no longer be executed.',
  'Authority unchanged': 'Authority is unchanged. No update needed.',
  'Config not initialized': 'Configuration is not initialized. Please initialize it first.',
  'Config factory mismatch': 'Configuration factory mismatch. Please verify the factory.',
  'Account data read failed': 'Failed to read account data. Please try again.',
  'Invalid mint format': 'Invalid mint format. Please verify the mint.',
  'Decimals mismatch': 'Decimals mismatch. Please verify the configuration.',
  'Invalid verifier program': 'Invalid verifier program. Please verify the program.',
  
  // Program-specific errors (Verifier)
  'Verifying key data must not be empty': 'Verifying key data is empty. Please provide valid key data.',
  'Verifying key id must be provided': 'Verifying key ID is required. Please provide it.',
  'Proof must not be empty': 'Proof is empty. Please provide a valid proof.',
  'Public inputs must not be empty': 'Public inputs are empty. Please provide valid inputs.',
  'Unauthorized authority - only factory can create keys': 'Only the factory program can create verifying keys.',
  'Verifying key version is too old and no longer supported': 'Verifying key version is too old. Please use a newer version.',
  'Verifying key format is invalid': 'Invalid verifying key format. Please verify the key.',
  'Verifying key has been revoked': 'This verifying key has been revoked and can no longer be used.',
  'Verifying key is already revoked': 'This verifying key is already revoked.',
  'Invalid program ID': 'Invalid program ID. Please verify the program.',
  'Invalid circuit tag': 'Invalid circuit tag. Please verify the tag.',
};

/**
 * Extracts error message from various error types (Anchor errors, SendTransactionError, etc.)
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof SendTransactionError) {
    // Try to extract Anchor error from logs
    const logs = error.logs || [];
    for (const log of logs) {
      // Look for "Error Code: <ErrorName>. Error Number: <number>. Error Message: <message>"
      const anchorErrorMatch = log.match(/Error Message: (.+?)(?:\.|$)/);
      if (anchorErrorMatch) {
        return anchorErrorMatch[1].trim();
      }
      // Also check for "Error Code: <ErrorName>"
      const errorCodeMatch = log.match(/Error Code: ([^.]+)/);
      if (errorCodeMatch) {
        const errorCode = errorCodeMatch[1].trim();
        // Try to find a matching error message
        if (ERROR_MESSAGES[errorCode]) {
          return errorCode;
        }
      }
    }
  }
  
  if (error instanceof Error) {
    return error.message;
  }
  
  return String(error);
}

/**
 * Normalizes error messages to user-friendly format using standardized error mappings.
 */
export function normalizeError(error: unknown): string {
  const message = extractErrorMessage(error);
  
  // Check for special Solana errors
  if (error instanceof SendTransactionError) {
    const debitLog = error.logs?.find((entry) =>
      entry.includes('Attempt to debit an account but found no record of a prior credit')
    );
    if (debitLog) {
      return 'Destination wallet needs SOL to create its public token account. Fund it via the Faucet, then retry.';
    }
  }
  
  if (message.includes('Attempt to debit an account but found no record of a prior credit')) {
    return 'Destination wallet needs SOL to create its public token account. Fund it via the Faucet, then retry.';
  }
  
  // Map standardized error messages to user-friendly messages
  if (ERROR_MESSAGES[message]) {
    return ERROR_MESSAGES[message];
  }
  
  // Check for partial matches (e.g., "Error Code: InvalidAmount" -> "Invalid amount")
  for (const [key, value] of Object.entries(ERROR_MESSAGES)) {
    if (message.includes(key) || message.toLowerCase().includes(key.toLowerCase())) {
      return value;
    }
  }
  
  // Return original message if no mapping found
  return message || 'Transaction failed';
}

/**
 * Checks if an error is a specific standardized error type.
 */
export function isErrorType(error: unknown, errorMessage: string): boolean {
  const message = extractErrorMessage(error);
  return message === errorMessage || message.includes(errorMessage);
}

/**
 * Checks if an error is a rate limiting error.
 */
export function isRateLimitError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return message.includes('Rate limited') || 
         message.includes('rate limit') ||
         message.includes('RateLimited');
}

/**
 * Checks if an error is a pending shield error.
 */
export function isPendingShieldError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return message.includes('Pending shield in flight') ||
         message.includes('PendingShieldInFlight') ||
         message.includes('0x1793') ||
         message.includes('6035');
}

