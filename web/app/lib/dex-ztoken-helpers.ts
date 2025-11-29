/**
 * zToken DEX Operations - Helper Functions
 * 
 * Provides utilities for zToken operations in the DEX:
 * - Account derivation for zToken pool CPIs
 * - Proof generation for shield/transfer operations
 * - Proof data conversion for instruction parameters
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { ProofResponse, ProofClient } from './proofClient';
import {
  derivePoolState,
  deriveCommitmentTree,
  deriveNullifierSet,
  deriveNoteLedger,
  deriveHookConfig,
  deriveHookWhitelist,
  deriveVaultState,
  deriveShieldClaim,
  deriveMintMapping,
  deriveFactoryState,
  deriveVerifyingKey
} from './onchain/pdas';
import { VERIFIER_PROGRAM_ID } from './onchain/programIds';
import { decodeCommitmentTree } from './onchain/commitmentTree';
import { bytesLEToCanonicalHex, canonicalHexToBytesLE } from './onchain/utils';
import { poseidonHashMany } from './onchain/poseidon';

/**
 * Get all zToken pool accounts for remaining_accounts in CPI calls.
 * Returns accounts in the order required by ptf_pool instructions.
 * 
 * @param originMint - The zToken origin mint
 * @param forShield - If true, includes shield-specific accounts (14 accounts). If false, only transfer accounts (7 accounts).
 * @returns Array of account public keys in correct order
 */
export function getZTokenPoolAccounts(
  originMint: PublicKey,
  forShield: boolean = false
): PublicKey[] {
  const poolState = derivePoolState(originMint);
  const commitmentTree = deriveCommitmentTree(originMint);
  const nullifierSet = deriveNullifierSet(originMint);
  const noteLedger = deriveNoteLedger(originMint);
  const mintMapping = deriveMintMapping(originMint);
  const verifyingKey = deriveVerifyingKey();
  
  const accounts: PublicKey[] = [];
  
  if (forShield) {
    // Shield accounts order (from ztoken_cpi.rs):
    // pool_state, hook_config, hook_whitelist, nullifier_set, commitment_tree,
    // note_ledger, vault_state, vault_token_account, depositor_token_account,
    // twin_mint (optional), verifier_program, verifying_key, origin_mint,
    // mint_mapping, factory_state, vault_program, token_program, system_program, rent
    // But we only return the accounts that go in remaining_accounts (not system accounts)
    const hookConfig = deriveHookConfig(originMint);
    const hookWhitelist = deriveHookWhitelist(originMint);
    const vaultState = deriveVaultState(originMint);
    const shieldClaim = deriveShieldClaim(poolState);
    const factoryState = deriveFactoryState();
    
    accounts.push(
      poolState,
      nullifierSet,
      commitmentTree,
      noteLedger,
      mintMapping,
      VERIFIER_PROGRAM_ID,
      verifyingKey,
      vaultState,
      shieldClaim,
      hookConfig,
      hookWhitelist,
      factoryState
      // vault_token_account, depositor_token_account, twin_mint are passed separately
    );
  } else {
    // Transfer accounts order (from ztoken_cpi.rs):
    // pool_state, nullifier_set, commitment_tree, note_ledger, mint_mapping,
    // verifier_program, verifying_key
    accounts.push(
      poolState,
      nullifierSet,
      commitmentTree,
      noteLedger,
      mintMapping,
      VERIFIER_PROGRAM_ID,
      verifyingKey
    );
  }
  
  return accounts;
}

/**
 * Fetch current commitment tree root for a zToken pool.
 * 
 * @param connection - Solana connection
 * @param originMint - The zToken origin mint
 * @returns Current root as canonical hex string
 */
export async function fetchZTokenPoolRoot(
  connection: Connection,
  originMint: PublicKey
): Promise<string> {
  const commitmentTreeKey = deriveCommitmentTree(originMint);
  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
  
  if (!commitmentTreeAccount) {
    // Pool not initialized yet - return default empty root
    return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }
  
  const treeState = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
  return bytesLEToCanonicalHex(Buffer.from(treeState.currentRoot));
}

/**
 * Generate shield proof for DEX pool operation (Public → zToken).
 * This shields tokens to the DEX pool PDA.
 * 
 * @param proofClient - Proof client instance
 * @param connection - Solana connection
 * @param originMint - The zToken origin mint
 * @param amount - Amount to shield
 * @param recipient - Recipient of the shielded tokens (DEX pool PDA)
 * @returns Shield proof response with proof data
 */
export async function generateDexShieldProof(
  proofClient: ProofClient,
  connection: Connection,
  originMint: PublicKey,
  amount: bigint,
  recipient: PublicKey
): Promise<ProofResponse & { 
  depositId: string;
  blinding: string;
  amountCommit: Uint8Array;
}> {
  // Fetch current root
  const currentRoot = await fetchZTokenPoolRoot(connection, originMint);
  
  // Generate deposit ID and blinding
  const depositId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
  const blinding = Math.floor(Math.random() * 10 ** 18).toString();
  
  const poolState = derivePoolState(originMint);
  const poolId = poolState.toBase58();
  
  // Request shield proof
  const proof = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: amount.toString(),
    recipient: recipient.toBase58(),
    depositId,
    poolId,
    blinding,
    mintId: originMint.toBase58()
  });
  
  // Calculate amount commitment (Poseidon hash of amount and blinding)
  const amountCommit = await poseidonHashMany([amount, BigInt(blinding)]);
  
  return {
    ...proof,
    depositId,
    blinding,
    amountCommit
  };
}

/**
 * Generate transfer proof for DEX pool operation (zToken → zToken or zToken transfers).
 * 
 * @param proofClient - Proof client instance
 * @param connection - Solana connection
 * @param originMint - The zToken origin mint
 * @param notes - Input notes to spend
 * @param outputs - Output notes to create (amount, recipient, blinding for each)
 * @returns Transfer proof response with proof data
 */
export async function generateDexTransferProof(
  proofClient: ProofClient,
  connection: Connection,
  originMint: PublicKey,
  notes: Array<{
    noteId: string;
    spendingKey: string;
    amount: bigint;
  }>,
  outputs: Array<{
    amount: bigint;
    recipient: PublicKey;
    blinding: string;
  }>
): Promise<ProofResponse & {
  oldRoot: string;
  nullifiers: Uint8Array[];
  outputCommitments: Uint8Array[];
  outputAmountCommitments: Uint8Array[];
}> {
  // Fetch current root
  const currentRoot = await fetchZTokenPoolRoot(connection, originMint);
  
  const poolState = derivePoolState(originMint);
  const poolId = poolState.toBase58();
  
  // Prepare transfer payload
  const inNotes = notes.map(note => ({
    noteId: note.noteId,
    spendingKey: note.spendingKey,
    amount: note.amount.toString()
  }));
  
  const outNotes = outputs.map(output => ({
    amount: output.amount.toString(),
    recipient: output.recipient.toBase58(),
    blinding: output.blinding
  }));
  
  // Request transfer proof
  const proof = await proofClient.requestProof('transfer', {
    oldRoot: currentRoot,
    mintId: originMint.toBase58(),
    poolId,
    inNotes,
    outNotes
  });
  
  // Calculate output commitments and amount commitments
  const outputCommitments: Uint8Array[] = [];
  const outputAmountCommitments: Uint8Array[] = [];
  
  for (const output of outputs) {
    // Note: Actual commitment calculation requires field element conversion
    // For now, we'll use a simplified version - full implementation needs proper field arithmetic
    const amountCommit = await poseidonHashMany([output.amount, BigInt(output.blinding)]);
    outputAmountCommitments.push(amountCommit);
    
    // Output commitment (note commitment) = poseidon(recipient, amount, blinding)
    // TODO: Properly convert recipient pubkey to field element
    const commitment = await poseidonHashMany([
      BigInt(output.recipient.toBase58().slice(0, 10)), // Simplified - use proper field conversion
      output.amount,
      BigInt(output.blinding)
    ]);
    outputCommitments.push(commitment);
  }
  
  // Extract nullifiers from proof (will be in publicInputs)
  // TODO: Parse publicInputs to extract actual nullifiers
  const nullifiers: Uint8Array[] = [];
  
  return {
    ...proof,
    oldRoot: currentRoot,
    nullifiers,
    outputCommitments,
    outputAmountCommitments
  };
}

/**
 * Convert proof response to ShieldArgs format for DEX instruction.
 * 
 * @param proofResponse - Proof response from generateDexShieldProof
 * @returns ShieldArgs object ready for instruction encoding
 */
export function proofToShieldArgs(proofResponse: {
  proof: string;
  publicInputs: string[];
  amountCommit: Uint8Array;
  amount: bigint;
}): {
  amount_commit: number[];
  amount: number;
  proof: number[];
  public_inputs: number[];
} {
  // Decode base64 proof to bytes
  const proofBytes = Buffer.from(proofResponse.proof, 'base64');
  
  // Serialize public inputs (array of hex strings to bytes)
  const publicInputsBytes = Buffer.concat(
    proofResponse.publicInputs.map(hex => {
      const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
      return Buffer.from(normalized.padStart(64, '0'), 'hex');
    })
  );
  
  return {
    amount_commit: Array.from(proofResponse.amountCommit),
    amount: Number(proofResponse.amount),
    proof: Array.from(proofBytes),
    public_inputs: Array.from(publicInputsBytes)
  };
}

/**
 * Convert proof response to TransferArgs format for DEX instruction.
 * 
 * @param proofResponse - Proof response from generateDexTransferProof
 * @returns TransferArgs object ready for instruction encoding
 */
export function proofToTransferArgs(proofResponse: {
  proof: string;
  publicInputs: string[];
  oldRoot: string;
  nullifiers: Uint8Array[];
  outputCommitments: Uint8Array[];
  outputAmountCommitments: Uint8Array[];
}): {
  old_root: number[];
  new_root: number[];
  nullifiers: number[][];
  output_commitments: number[][];
  output_amount_commitments: number[][];
  proof: number[];
  public_inputs: number[];
} {
  // Decode base64 proof to bytes
  const proofBytes = Buffer.from(proofResponse.proof, 'base64');
  
  // Serialize public inputs
  const publicInputsBytes = Buffer.concat(
    proofResponse.publicInputs.map(hex => {
      const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
      return Buffer.from(normalized.padStart(64, '0'), 'hex');
    })
  );
  
  // Convert roots from hex strings to bytes
  const oldRootBytes = canonicalHexToBytesLE(proofResponse.oldRoot);
  
  // Extract new root from public inputs (typically first element after old root)
  // TODO: Properly parse publicInputs to extract newRoot
  const newRootBytes = oldRootBytes; // Placeholder - should extract from proofResponse.publicInputs
  
  return {
    old_root: Array.from(oldRootBytes),
    new_root: Array.from(newRootBytes),
    nullifiers: proofResponse.nullifiers.map(n => Array.from(n)),
    output_commitments: proofResponse.outputCommitments.map(c => Array.from(c)),
    output_amount_commitments: proofResponse.outputAmountCommitments.map(c => Array.from(c)),
    proof: Array.from(proofBytes),
    public_inputs: Array.from(publicInputsBytes)
  };
}

