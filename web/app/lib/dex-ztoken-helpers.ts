/**
 * zToken DEX Operations - Helper Functions
 * 
 * Provides utilities for zToken operations in the DEX:
 * - Account derivation for zToken pool CPIs
 * - Proof generation for shield/transfer operations
 * - Proof data conversion for instruction parameters
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
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
import { bytesLEToCanonicalHex, canonicalHexToBytesLE, canonicalizeHex } from './onchain/utils';
import { poseidonHashMany } from './onchain/poseidon';

/**
 * Convert a public key to a field string (for proof RPC)
 */
function pubkeyToFieldString(key: PublicKey): string {
  const hex = Buffer.from(key.toBytes()).toString('hex');
  return BigInt(`0x${hex}`).toString();
}

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
  
  const accounts: PublicKey[] = [
    poolState,
    nullifierSet,
    commitmentTree,
    noteLedger,
    mintMapping,
    VERIFIER_PROGRAM_ID,
    verifyingKey
  ];
  
  if (forShield) {
    // Add shield-specific accounts
    const hookConfig = deriveHookConfig(originMint);
    const hookWhitelist = deriveHookWhitelist(originMint);
    const vaultState = deriveVaultState(originMint);
    const shieldClaim = deriveShieldClaim(poolState);
    const factoryState = deriveFactoryState();
    
    accounts.push(
      vaultState,
      shieldClaim,
      hookConfig,
      hookWhitelist,
      factoryState
      // Note: vault_token_account, depositor_token_account, twin_mint are passed separately
      // They need to be added to remaining_accounts by the caller
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
  // Deposit ID must be numeric (proof RPC converts to BigInt)
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1_000_000);
  const depositId = `${timestamp}${random}`;
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
 * Generate a random blinding value for transfer outputs
 */
function generateRandomBlinding(): string {
  return Math.floor(Math.random() * 10 ** 18).toString();
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
    recipient: pubkeyToFieldString(output.recipient), // Convert pubkey to field string for proof RPC
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
    // Convert recipient pubkey to field element
    const recipientField = BigInt(pubkeyToFieldString(output.recipient));
    const commitment = await poseidonHashMany([
      recipientField,
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
 * Simplified wrapper for generating transfer proofs with automatic change handling.
 * Calculates total input, generates change output if needed, and creates the transfer proof.
 * 
 * @param proofClient - Proof client instance
 * @param connection - Solana connection
 * @param originMint - The zToken origin mint
 * @param notes - Input notes to spend
 * @param transferAmount - Amount to transfer to recipient
 * @param recipient - Recipient public key
 * @param changeRecipient - Recipient for change (defaults to first note owner)
 * @returns Transfer proof response with proof data
 */
export async function generateDexTransferProofSimple(
  proofClient: ProofClient,
  connection: Connection,
  originMint: PublicKey,
  notes: Array<{
    noteId: string;
    spendingKey: string;
    amount: bigint;
  }>,
  transferAmount: bigint,
  recipient: PublicKey,
  changeRecipient?: PublicKey
): Promise<ProofResponse & {
  oldRoot: string;
  nullifiers: Uint8Array[];
  outputCommitments: Uint8Array[];
  outputAmountCommitments: Uint8Array[];
  outputs: Array<{
    amount: bigint;
    recipient: PublicKey;
    blinding: string;
  }>;
}> {
  // Calculate total input
  const totalInput = notes.reduce((sum, note) => sum + note.amount, 0n);
  
  if (totalInput < transferAmount) {
    throw new Error(`Insufficient notes: have ${totalInput}, need ${transferAmount}`);
  }
  
  const changeAmount = totalInput - transferAmount;
  
  // Build outputs array
  const outputs: Array<{
    amount: bigint;
    recipient: PublicKey;
    blinding: string;
  }> = [
    {
      amount: transferAmount,
      recipient,
      blinding: generateRandomBlinding()
    }
  ];
  
  // Add change output if needed
  if (changeAmount > 0n) {
    outputs.push({
      amount: changeAmount,
      recipient: changeRecipient || recipient, // Default to recipient if no change recipient
      blinding: generateRandomBlinding()
    });
  }
  
  // Generate the transfer proof
  const proof = await generateDexTransferProof(
    proofClient,
    connection,
    originMint,
    notes,
    outputs
  );
  
  return {
    ...proof,
    outputs
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
  amountCommit: Uint8Array | Buffer;
  amount: bigint;
}): {
  amount_commit: number[];
  amount: BN;
  proof: Buffer;
  public_inputs: Buffer;
} {
  // Decode base64 proof to bytes (same as decodeProofPayload)
  const proofBytes = Buffer.from(proofResponse.proof, 'base64');
  
  // Serialize public inputs using the same logic as decodeProofPayload
  // Each public input is canonicalized and converted to 32-byte little-endian format
  const fieldBytes = proofResponse.publicInputs.map((input, index) => {
    if (typeof input !== 'string') {
      throw new Error(`Public input at index ${index} is not a string`);
    }
    const canonical = canonicalizeHex(input);
    const bytes = canonicalHexToBytesLE(canonical, 32);
    if (bytes.length !== 32) {
      throw new Error(`Public input at index ${index} must be 32 bytes`);
    }
    return bytes;
  });
  
  // Flatten public inputs into a single Buffer (same as decodeProofPayload)
  const publicInputsBytes = Buffer.concat(fieldBytes.map((entry) => Buffer.from(entry)));
  
  // Convert amountCommit to array (handle both Buffer and Uint8Array)
  // Ensure it's exactly 32 bytes (pad or truncate if needed)
  let amountCommitBuf = Buffer.isBuffer(proofResponse.amountCommit)
    ? Buffer.from(proofResponse.amountCommit)
    : Buffer.from(proofResponse.amountCommit);
  
  // Pad or truncate to exactly 32 bytes
  if (amountCommitBuf.length < 32) {
    amountCommitBuf = Buffer.concat([amountCommitBuf, Buffer.alloc(32 - amountCommitBuf.length)]);
  } else if (amountCommitBuf.length > 32) {
    amountCommitBuf = amountCommitBuf.slice(0, 32);
  }
  
  return {
    amount_commit: Array.from(amountCommitBuf),
    amount: new BN(proofResponse.amount.toString()), // Convert bigint to BN for u64 encoding
    proof: proofBytes, // Buffer for bytes type in IDL (same format as SDK)
    public_inputs: publicInputsBytes // Buffer for bytes type in IDL (same format as SDK)
  };
}

/**
 * Create empty ShieldArgs for empty pool creation (when amounts are 0).
 * The program will skip shield CPIs when amounts are 0, so these are dummy values.
 * 
 * @returns Empty ShieldArgs with zeros/minimal values
 */
export function createEmptyShieldArgs(): {
  amount_commit: number[];
  amount: BN;
  proof: Buffer;
  public_inputs: Buffer;
} {
  return {
    amount_commit: Array.from(Buffer.alloc(32, 0)), // 32 bytes of zeros
    amount: new BN(0),
    proof: Buffer.alloc(0), // Empty proof
    public_inputs: Buffer.alloc(0) // Empty public inputs
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
  proof: Buffer;
  public_inputs: Buffer;
} {
  // Decode base64 proof to bytes
  const proofBytesRaw = Buffer.from(proofResponse.proof, 'base64');
  
  // Ensure proof is exactly 192 bytes (Groth16 proof format)
  // Create a new Buffer with exact size to avoid any padding issues
  const proofBytes = proofBytesRaw.length === 192 
    ? Buffer.from(proofBytesRaw) // Create new instance
    : proofBytesRaw.length < 192
      ? Buffer.concat([proofBytesRaw, Buffer.alloc(192 - proofBytesRaw.length, 0)])
      : Buffer.from(proofBytesRaw.slice(0, 192));
  
  // Serialize public inputs using the same logic as decodeProofPayload
  // Each public input is canonicalized and converted to 32-byte little-endian format
  const fieldBytes = proofResponse.publicInputs.map((input, index) => {
    if (typeof input !== 'string') {
      throw new Error(`Public input at index ${index} is not a string`);
    }
    const canonical = canonicalizeHex(input);
    const bytes = canonicalHexToBytesLE(canonical, 32);
    if (bytes.length !== 32) {
      throw new Error(`Public input at index ${index} must be 32 bytes`);
    }
    return bytes;
  });
  
  // Flatten public inputs into a single Buffer (same format as decodeProofPayload)
  const publicInputsBytes = Buffer.concat(fieldBytes.map((entry) => Buffer.from(entry)));
  
  // Convert roots from hex strings to bytes
  const oldRootBytes = canonicalHexToBytesLE(proofResponse.oldRoot);
  
  // Extract new root from public inputs (first element is typically new root)
  // Public inputs format: [newRoot, ...nullifiers, ...outputCommitments, ...]
  const newRootBytes = fieldBytes.length > 0 ? fieldBytes[0] : oldRootBytes;
  
  // For Anchor's bytes type (Vec<u8> in Rust), Borsh encoding adds a 4-byte length prefix
  // Anchor's BorshCoder should handle this automatically
  // Try using plain Array instead of Buffer - Anchor might handle Array better for Vec<u8>
  return {
    old_root: Array.from(oldRootBytes),
    new_root: Array.from(newRootBytes),
    nullifiers: proofResponse.nullifiers.map(n => Array.from(n)),
    output_commitments: proofResponse.outputCommitments.map(c => Array.from(c)),
    output_amount_commitments: proofResponse.outputAmountCommitments.map(c => Array.from(c)),
    proof: proofBytes, // Buffer for Anchor Vec<u8>
    public_inputs: publicInputsBytes // Buffer for Anchor Vec<u8>
  };
}

/**
 * Generate batch transfer proof for multiple transfers (2-10 tokens) in a single proof.
 * This solves the transaction size issue for DEX operations like add_liquidity.
 * 
 * @param proofClient - Proof client instance
 * @param connection - Solana connection
 * @param transfers - Array of transfer specifications, one per mint
 * @returns Batch transfer proof response with combined proof data
 */
export async function generateBatchTransferProof(
  proofClient: ProofClient,
  connection: Connection,
  transfers: Array<{
    originMint: PublicKey;
    notes: Array<{
      noteId: string;
      spendingKey: string;
      amount: bigint;
    }>;
    outputs: Array<{
      amount: bigint;
      recipient: PublicKey;
      blinding: string;
    }>;
  }>
): Promise<ProofResponse & {
  transfers: Array<{
    oldRoot: string;
    newRoot: string;
    nullifiers: Uint8Array[];
    outputCommitments: Uint8Array[];
    outputAmountCommitments: Uint8Array[];
  }>;
}> {
  if (transfers.length < 2 || transfers.length > 10) {
    throw new Error('Batch transfer requires 2-10 transfers');
  }
  
  // Fetch current roots for all pools
  const poolRoots = await Promise.all(
    transfers.map(transfer => fetchZTokenPoolRoot(connection, transfer.originMint))
  );
  
  // Prepare batch transfer payload
  const batchTransfers = transfers.map((transfer, index) => {
    const poolState = derivePoolState(transfer.originMint);
    const poolId = poolState.toBase58();
    
    // Ensure we have exactly 2 input notes (pad with zeros if needed)
    const paddedInNotes = [...transfer.notes];
    while (paddedInNotes.length < 2) {
      paddedInNotes.push({ 
        noteId: '0', 
        spendingKey: '0', 
        amount: 0n 
      });
    }
    
    // Ensure we have exactly 2 output notes (pad with zeros if needed)
    const paddedOutNotes = [...transfer.outputs];
    while (paddedOutNotes.length < 2) {
      paddedOutNotes.push({
        amount: 0n,
        recipient: PublicKey.default,
        blinding: '0'
      });
    }
    
    return {
      oldRoot: poolRoots[index]!,
      mintId: transfer.originMint.toBase58(),
      poolId,
      inNotes: paddedInNotes.slice(0, 2).map(note => ({
        noteId: note.noteId,
        spendingKey: note.spendingKey,
        amount: note.amount.toString()
      })),
      outNotes: paddedOutNotes.slice(0, 2).map(output => ({
        amount: output.amount.toString(),
        recipient: pubkeyToFieldString(output.recipient),
        blinding: output.blinding
      }))
    };
  });
  
  // Request batch transfer proof
  const proof = await proofClient.requestProof('batch_transfer', {
    transfers: batchTransfers
  });
  
  // Parse batch public inputs to extract individual transfer data
  // Batch structure: 16 field elements (8 per transfer × 2 transfers)
  const fields = proof.publicInputs;
  if (fields.length !== transfers.length * 8) {
    throw new Error(`Invalid batch public inputs length: expected ${transfers.length * 8}, got ${fields.length}`);
  }
  
  const transferResults: Array<{
    oldRoot: string;
    newRoot: string;
    nullifiers: Uint8Array[];
    outputCommitments: Uint8Array[];
    outputAmountCommitments: Uint8Array[];
  }> = [];
  
  // Process each transfer's data from batch public inputs
  for (let i = 0; i < transfers.length; i++) {
    const offset = i * 8;
    const oldRoot = fields[offset]!;
    const newRoot = fields[offset + 1]!;
    const nullifier0 = fields[offset + 2]!;
    const nullifier1 = fields[offset + 3]!;
    const outputCommit0 = fields[offset + 4]!;
    const outputCommit1 = fields[offset + 5]!;
    
    // Convert field elements to bytes
    const nullifiers: Uint8Array[] = [
      canonicalHexToBytesLE(nullifier0),
      canonicalHexToBytesLE(nullifier1)
    ];
    
    const outputCommitments: Uint8Array[] = [
      canonicalHexToBytesLE(outputCommit0),
      canonicalHexToBytesLE(outputCommit1)
    ];
    
    // Calculate output amount commitments from outputs
    const outputAmountCommitments: Uint8Array[] = [];
    const transferOutputs = transfers[i]!.outputs.slice(0, 2);
    for (const output of transferOutputs) {
      if (output.amount === 0n) {
        // Zero output
        outputAmountCommitments.push(Buffer.alloc(32));
      } else {
        const amountCommit = await poseidonHashMany([output.amount, BigInt(output.blinding)]);
        outputAmountCommitments.push(amountCommit);
      }
    }
    
    // Pad to exactly 2 (ensure we always have 2 amount commitments)
    while (outputAmountCommitments.length < 2) {
      outputAmountCommitments.push(Buffer.alloc(32));
    }
    
    // Return exactly 2 nullifiers and 2 commitments (circuit expects exactly 2)
    // Nullifiers and outputCommitments are already exactly 2 from public inputs
    transferResults.push({
      oldRoot,
      newRoot,
      nullifiers: nullifiers.slice(0, 2), // Exactly 2 nullifiers
      outputCommitments: outputCommitments.slice(0, 2), // Exactly 2 commitments
      outputAmountCommitments: outputAmountCommitments.slice(0, 2) // Exactly 2 amount commitments
    });
  }
  
  return {
    ...proof,
    transfers: transferResults
  };
}

/**
 * Generate batch transfer proof specifically for DEX add_liquidity operation.
 * This is a convenience wrapper that handles the common case of adding liquidity
 * with two tokens (token A and token B) to a pool PDA.
 * 
 * @param proofClient - Proof client instance
 * @param connection - Solana connection
 * @param tokenAMint - Token A mint address
 * @param tokenBMint - Token B mint address
 * @param notesA - User's notes for token A to spend
 * @param notesB - User's notes for token B to spend
 * @param amountA - Amount of token A to transfer to pool
 * @param amountB - Amount of token B to transfer to pool
 * @param poolStatePDA - DEX pool state PDA (recipient for both transfers)
 * @param userPayer - User's public key (recipient for change)
 * @returns Batch transfer proof response
 */
export async function generateBatchLiquidityProof(
  proofClient: ProofClient,
  connection: Connection,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  notesA: Array<{
    noteId: string;
    spendingKey: string;
    amount: bigint;
  }>,
  notesB: Array<{
    noteId: string;
    spendingKey: string;
    amount: bigint;
  }>,
  amountA: bigint,
  amountB: bigint,
  poolStatePDA: PublicKey,
  userPayer: PublicKey
): Promise<ReturnType<typeof generateBatchTransferProof>> {
  // Select notes for each token (same logic as addDexLiquidity)
  function selectNotesForAmount(
    notes: Array<{ noteId: string; spendingKey: string; amount: bigint }>,
    target: bigint
  ): Array<{ noteId: string; spendingKey: string; amount: bigint }> {
    if (!notes.length) {
      throw new Error('No notes available');
    }
    const sorted = [...notes].sort((a, b) => {
      const diff = a.amount - b.amount;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    const single = sorted.find(note => note.amount >= target);
    if (single) {
      return [single];
    }
    let bestPair: { total: bigint; notes: Array<{ noteId: string; spendingKey: string; amount: bigint }> } | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      for (let j = i - 1; j >= 0; j--) {
        const total = sorted[i]!.amount + sorted[j]!.amount;
        if (total >= target) {
          if (!bestPair || total < bestPair.total) {
            bestPair = { total, notes: [sorted[i]!, sorted[j]!] };
          }
        }
      }
    }
    if (bestPair) {
      return bestPair.notes;
    }
    throw new Error(`Insufficient notes: need ${target}, have ${sorted.reduce((sum, n) => sum + n.amount, 0n)}`);
  }
  
  const selectedNotesA = selectNotesForAmount(notesA, amountA);
  const selectedNotesB = selectNotesForAmount(notesB, amountB);
  
  // Calculate total input and change for each token
  const totalInputA = selectedNotesA.reduce((sum, note) => sum + note.amount, 0n);
  const totalInputB = selectedNotesB.reduce((sum, note) => sum + note.amount, 0n);
  const changeA = totalInputA - amountA;
  const changeB = totalInputB - amountB;
  
  // Build outputs for token A: [to pool PDA, change back to user]
  const outputsA: Array<{ amount: bigint; recipient: PublicKey; blinding: string }> = [
    {
      amount: amountA,
      recipient: poolStatePDA,
      blinding: generateRandomBlinding()
    }
  ];
  if (changeA > 0n) {
    outputsA.push({
      amount: changeA,
      recipient: userPayer,
      blinding: generateRandomBlinding()
    });
  }
  
  // Build outputs for token B: [to pool PDA, change back to user]
  const outputsB: Array<{ amount: bigint; recipient: PublicKey; blinding: string }> = [
    {
      amount: amountB,
      recipient: poolStatePDA,
      blinding: generateRandomBlinding()
    }
  ];
  if (changeB > 0n) {
    outputsB.push({
      amount: changeB,
      recipient: userPayer,
      blinding: generateRandomBlinding()
    });
  }
  
  // Generate batch transfer proof for both tokens
  return generateBatchTransferProof(proofClient, connection, [
    {
      originMint: tokenAMint,
      notes: selectedNotesA,
      outputs: outputsA
    },
    {
      originMint: tokenBMint,
      notes: selectedNotesB,
      outputs: outputsB
    }
  ]);
}

/**
 * Generate batch transfer from proof (with allowances).
 * Similar to generateBatchTransferProof but includes allowance info for each transfer.
 * The circuit itself doesn't use allowance info (verified programmatically), but it's
 * included in the payload for SDK validation.
 * 
 * @param proofClient - Proof client instance
 * @param connection - Solana connection
 * @param transfers - Array of transfer specs with allowance info
 * @returns Batch transfer proof response with transfer data
 */
export async function generateBatchTransferFromProof(
  proofClient: ProofClient,
  connection: Connection,
  transfers: Array<{
    originMint: PublicKey;
    notes: Array<{
      noteId: string;
      spendingKey: string;
      amount: bigint;
    }>;
    outputs: Array<{
      amount: bigint;
      recipient: PublicKey;
      blinding: string;
    }>;
    allowanceAmount: bigint;
    spendAmount: bigint;
    allowanceOwner: PublicKey;
  }>
): Promise<ProofResponse & {
  transfers: Array<{
    oldRoot: string;
    newRoot: string;
    nullifiers: Uint8Array[];
    outputCommitments: Uint8Array[];
    outputAmountCommitments: Uint8Array[];
  }>;
}> {
  if (transfers.length < 2 || transfers.length > 10) {
    throw new Error('Batch transferFrom requires 2-10 transfers');
  }
  
  // Fetch current roots for all pools
  const poolRoots = await Promise.all(
    transfers.map(transfer => fetchZTokenPoolRoot(connection, transfer.originMint))
  );
  
  // Prepare batch transfer from payload (includes allowance info)
  const batchTransfers = transfers.map((transfer, index) => {
    const poolState = derivePoolState(transfer.originMint);
    const poolId = poolState.toBase58();
    
    // Ensure we have exactly 2 input notes (pad with zeros if needed)
    const paddedInNotes = [...transfer.notes];
    while (paddedInNotes.length < 2) {
      paddedInNotes.push({ 
        noteId: '0', 
        spendingKey: '0', 
        amount: 0n 
      });
    }
    
    // Ensure we have exactly 2 output notes (pad with zeros if needed)
    const paddedOutNotes = [...transfer.outputs];
    while (paddedOutNotes.length < 2) {
      paddedOutNotes.push({
        amount: 0n,
        recipient: PublicKey.default,
        blinding: '0'
      });
    }
    
    return {
      oldRoot: poolRoots[index]!,
      mintId: transfer.originMint.toBase58(),
      poolId,
      inNotes: paddedInNotes.slice(0, 2).map(note => ({
        noteId: note.noteId,
        spendingKey: note.spendingKey,
        amount: note.amount.toString()
      })),
      outNotes: paddedOutNotes.slice(0, 2).map(output => ({
        amount: output.amount.toString(),
        recipient: pubkeyToFieldString(output.recipient),
        blinding: output.blinding
      })),
      // Allowance info (for program-level validation, not used in circuit)
      allowanceAmount: transfer.allowanceAmount.toString(),
      spendAmount: transfer.spendAmount.toString(),
      allowanceOwner: transfer.allowanceOwner.toBase58()
    };
  });
  
  // Request batch transfer from proof (circuit is same as batch_transfer)
  const proof = await proofClient.requestProof('batch_transfer_from', {
    transfers: batchTransfers
  });
  
  // Parse batch public inputs (same structure as batch_transfer)
  const fields = proof.publicInputs;
  if (fields.length !== transfers.length * 8) {
    throw new Error(`Invalid batch public inputs length: expected ${transfers.length * 8}, got ${fields.length}`);
  }
  
  const transferResults: Array<{
    oldRoot: string;
    newRoot: string;
    nullifiers: Uint8Array[];
    outputCommitments: Uint8Array[];
    outputAmountCommitments: Uint8Array[];
  }> = [];
  
  // Process each transfer's data from batch public inputs
  for (let i = 0; i < transfers.length; i++) {
    const offset = i * 8;
    const oldRoot = fields[offset]!;
    const newRoot = fields[offset + 1]!;
    const nullifier0 = fields[offset + 2]!;
    const nullifier1 = fields[offset + 3]!;
    const outputCommit0 = fields[offset + 4]!;
    const outputCommit1 = fields[offset + 5]!;
    
    // Convert field elements to bytes
    const nullifiers: Uint8Array[] = [
      canonicalHexToBytesLE(nullifier0),
      canonicalHexToBytesLE(nullifier1)
    ];
    
    const outputCommitments: Uint8Array[] = [
      canonicalHexToBytesLE(outputCommit0),
      canonicalHexToBytesLE(outputCommit1)
    ];
    
    // Calculate output amount commitments from outputs
    const outputAmountCommitments: Uint8Array[] = [];
    const transferOutputs = transfers[i]!.outputs.slice(0, 2);
    for (const output of transferOutputs) {
      if (output.amount === 0n) {
        // Zero output
        outputAmountCommitments.push(Buffer.alloc(32));
      } else {
        const amountCommit = await poseidonHashMany([output.amount, BigInt(output.blinding)]);
        outputAmountCommitments.push(amountCommit);
      }
    }
    
    // Pad to exactly 2 (ensure we always have 2 amount commitments)
    while (outputAmountCommitments.length < 2) {
      outputAmountCommitments.push(Buffer.alloc(32));
    }
    
    // Return exactly 2 nullifiers and 2 commitments (circuit expects exactly 2)
    transferResults.push({
      oldRoot,
      newRoot,
      nullifiers: nullifiers.slice(0, 2), // Exactly 2 nullifiers
      outputCommitments: outputCommitments.slice(0, 2), // Exactly 2 commitments
      outputAmountCommitments: outputAmountCommitments.slice(0, 2) // Exactly 2 amount commitments
    });
  }
  
  return {
    ...proof,
    transfers: transferResults
  };
}

