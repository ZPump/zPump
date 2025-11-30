/**
 * SOL Wrapping Utilities
 * 
 * Provides transparent SOL wrapping/unwrapping functions.
 * Users should never see wSOL - it's handled automatically in transactions.
 * All functions include comprehensive logging for debugging.
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAccount
} from '@solana/spl-token';
import type { WalletContextState } from '@solana/wallet-adapter-react';

/**
 * Native SOL mint address
 * This is the same on all networks (mainnet, devnet, localnet)
 */
export const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Check if a mint address is native SOL
 */
export function isNativeSol(mint: string | PublicKey): boolean {
  try {
    const mintKey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    return mintKey.equals(NATIVE_SOL_MINT) || mintKey.equals(NATIVE_MINT);
  } catch {
    return false;
  }
}

/**
 * Get or create wrapped SOL token account address
 * 
 * @param owner - Token account owner
 * @returns Associated token account public key for wSOL
 */
export async function getWrappedSolAccount(owner: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(
    NATIVE_MINT,
    owner,
    false, // allowOwnerOffCurve
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

/**
 * Get wrapped SOL balance for a user (internal use only - users never see this)
 */
export async function getWrappedSolBalance(
  connection: Connection,
  wallet: PublicKey
): Promise<bigint> {
  try {
    const wsolAccount = await getWrappedSolAccount(wallet);
    const tokenAccount = await getAccount(connection, wsolAccount, 'confirmed', TOKEN_PROGRAM_ID);
    return tokenAccount.amount;
  } catch {
    // Account doesn't exist = 0 balance
    return 0n;
  }
}

/**
 * Create instructions to wrap SOL to wSOL
 * Adds instructions to create ATA (if needed), transfer SOL, and sync native.
 * 
 * @param wsolTokenAccount - Wrapped SOL token account address
 * @param amount - Amount of SOL to wrap (in lamports)
 * @param payer - Account that will pay for the transaction
 * @param connection - Solana connection (for checking if account exists)
 * @returns Array of instructions to wrap SOL
 */
export async function createWrapSolInstructions(
  wsolTokenAccount: PublicKey,
  amount: bigint,
  payer: PublicKey,
  connection: Connection
): Promise<TransactionInstruction[]> {
  const instructions: TransactionInstruction[] = [];

  console.log(`[solWrapping] Creating wrap instructions: ${amount} lamports to ${wsolTokenAccount.toBase58()}`);

  // Check if token account exists
  const tokenAccountInfo = await connection.getAccountInfo(wsolTokenAccount, 'confirmed');
  
  if (!tokenAccountInfo) {
    // Create the token account first
    console.log(`[solWrapping] Creating wSOL token account: ${wsolTokenAccount.toBase58()}`);
    const createATAInstruction = createAssociatedTokenAccountInstruction(
      payer,
      wsolTokenAccount,
      payer,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    instructions.push(createATAInstruction);
  } else {
    console.log(`[solWrapping] wSOL token account already exists: ${wsolTokenAccount.toBase58()}`);
  }
  
  // Transfer SOL to the token account
  console.log(`[solWrapping] Transferring ${amount} lamports to wSOL account`);
  instructions.push(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: wsolTokenAccount,
      lamports: Number(amount)
    })
  );
  
  // Sync native (wrap) the SOL
  console.log(`[solWrapping] Syncing native (wrapping SOL to wSOL)`);
  instructions.push(
    createSyncNativeInstruction(
      wsolTokenAccount,
      TOKEN_PROGRAM_ID
    )
  );

  return instructions;
}

/**
 * Create instructions to unwrap wSOL to native SOL
 * Closes the wSOL token account and transfers SOL back to owner.
 * 
 * @param wsolTokenAccount - Wrapped SOL token account address
 * @param owner - Owner of the wSOL account (will receive native SOL)
 * @returns Instruction to unwrap wSOL
 */
export function createUnwrapSolInstruction(
  wsolTokenAccount: PublicKey,
  owner: PublicKey
): TransactionInstruction {
  console.log(`[solWrapping] Creating unwrap instruction: ${wsolTokenAccount.toBase58()} → ${owner.toBase58()}`);
  
  // Close the token account (this automatically unwraps to SOL)
  const instruction = createCloseAccountInstruction(
    wsolTokenAccount,
    owner, // destination (receives the SOL)
    owner, // owner
    [], // no multisig
    TOKEN_PROGRAM_ID
  );

  return instruction;
}

/**
 * Check if user has sufficient wSOL balance, or needs to wrap more
 * 
 * @param connection - Solana connection
 * @param owner - Token account owner
 * @param requiredAmount - Required wSOL amount in lamports
 * @returns Object with hasEnough flag and current balance
 */
export async function checkWrappedSolBalance(
  connection: Connection,
  owner: PublicKey,
  requiredAmount: bigint
): Promise<{ hasEnough: boolean; currentBalance: bigint; needsWrap: bigint }> {
  const currentBalance = await getWrappedSolBalance(connection, owner);
  const needsWrap = requiredAmount > currentBalance ? requiredAmount - currentBalance : 0n;
  const hasEnough = requiredAmount <= currentBalance;

  console.log(`[solWrapping] Balance check - Required: ${requiredAmount}, Current: ${currentBalance}, Needs wrap: ${needsWrap}`);

  return {
    hasEnough,
    currentBalance,
    needsWrap
  };
}

