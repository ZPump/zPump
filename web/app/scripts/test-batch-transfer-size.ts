/**
 * Test script to check batchTransfer transaction size
 * Determines if batchTransfer needs to be split into multiple instructions
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage
} from '@solana/web3.js';
import { batchTransfer, wrap, preparePool } from '../lib/sdk';
import { generateBatchTransferProof } from '../lib/dex-ztoken-helpers';
import { ProofClient } from '../lib/proofClient';
import { createWalletAdapter } from './utils/walletAdapter';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { bytesLEToCanonicalHex } from '../lib/onchain/utils';
import { derivePoolState } from '../lib/onchain/pdas';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const MINTS_API_URL = process.env.MINTS_API_URL ?? 'http://127.0.0.1:3000/api/mints';

interface MintConfig {
  originMint: string;
  poolId: string;
  symbol: string;
  decimals: number;
}

function generateUniqueSymbol(): string {
  const timestamp = Date.now().toString().slice(-3);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `TS${timestamp}${random}`;
}

async function createToken(symbol: string): Promise<MintConfig> {
  const response = await fetch(`${MINTS_API_URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, decimals: 6 })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create token ${symbol}: ${response.status} ${errorText}`);
  }
  
  const result = await response.json();
  return result.mint as MintConfig;
}

function randomBlinding(): string {
  return BigInt('0x' + require('crypto').randomBytes(32).toString('hex')).toString();
}

async function main() {
  console.info('[test-batch-transfer-size] Testing batchTransfer transaction size\n');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  // Create test user
  const user = Keypair.generate();
  const walletAdapter = createWalletAdapter(user);
  
  console.info(`[test-batch-transfer-size] Test user: ${user.publicKey.toBase58()}\n`);
  
  // Request airdrop for user
  console.info('[test-batch-transfer-size] Requesting SOL airdrop...');
  const airdropSig = await connection.requestAirdrop(user.publicKey, 2 * 10 ** 9);
  await connection.confirmTransaction(airdropSig, 'confirmed');
  console.info(`[test-batch-transfer-size] ✓ Airdrop received: ${airdropSig}\n`);
  
  // Create two tokens
  console.info('[test-batch-transfer-size] Creating tokens...');
  const symbol1 = generateUniqueSymbol();
  const symbol2 = generateUniqueSymbol();
  
  const [token1, token2] = await Promise.all([
    createToken(symbol1),
    createToken(symbol2)
  ]);
  
  console.info(`[test-batch-transfer-size] ✓ Token 1: ${token1.symbol} (${token1.originMint})`);
  console.info(`[test-batch-transfer-size] ✓ Token 2: ${token2.symbol} (${token2.originMint})\n`);
  
  // Prepare pools (ensure lookup tables exist)
  console.info('[test-batch-transfer-size] Preparing pools...');
  await Promise.all([
    preparePool({
      connection,
      wallet: walletAdapter,
      originMint: token1.originMint
    }),
    preparePool({
      connection,
      wallet: walletAdapter,
      originMint: token2.originMint
    })
  ]);
  console.info('[test-batch-transfer-size] ✓ Pools prepared\n');
  
  // Shield tokens for user
  console.info('[test-batch-transfer-size] Shielding tokens...');
  const amount = 1000000n;
  const recipient = Keypair.generate().publicKey;
  
  // Shield token1
  const timestamp1 = Date.now();
  const depositId1 = `${timestamp1}${Math.floor(Math.random() * 1_000_000)}`;
  const blinding1 = randomBlinding();
  const poolState1Key = derivePoolState(new PublicKey(token1.originMint));
  
  const proof1 = await proofClient.requestProof('wrap', {
    oldRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    amount: amount.toString(),
    recipient: user.publicKey.toBase58(),
    depositId: depositId1,
    poolId: poolState1Key.toBase58(),
    blinding: blinding1,
    mintId: token1.originMint
  });
  
  await wrap({
    connection,
    wallet: walletAdapter,
    originMint: token1.originMint,
    poolId: token1.poolId,
    amount,
    recipient: user.publicKey.toBase58(),
    depositId: depositId1,
    blinding: blinding1,
    proof: proof1,
    keypair: user
  });
  
  // Shield token2
  const timestamp2 = Date.now();
  const depositId2 = `${timestamp2}${Math.floor(Math.random() * 1_000_000)}`;
  const blinding2 = randomBlinding();
  const poolState2Key = derivePoolState(new PublicKey(token2.originMint));
  
  const proof2 = await proofClient.requestProof('wrap', {
    oldRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    amount: amount.toString(),
    recipient: user.publicKey.toBase58(),
    depositId: depositId2,
    poolId: poolState2Key.toBase58(),
    blinding: blinding2,
    mintId: token2.originMint
  });
  
  await wrap({
    connection,
    wallet: walletAdapter,
    originMint: token2.originMint,
    poolId: token2.poolId,
    amount,
    recipient: user.publicKey.toBase58(),
    depositId: depositId2,
    blinding: blinding2,
    proof: proof2,
    keypair: user
  });
  
  console.info('[test-batch-transfer-size] ✓ Tokens shielded\n');
  
  // Generate batch transfer proof
  console.info('[test-batch-transfer-size] Generating batch transfer proof...');
  const batchProof = await generateBatchTransferProof(
    proofClient,
    connection,
    [
      {
        originMint: new PublicKey(token1.originMint),
        notes: [{
          noteId: depositId1,
          spendingKey: blinding1,
          amount
        }],
        outputs: [{
          amount: 500000n,
          recipient,
          blinding: randomBlinding()
        }]
      },
      {
        originMint: new PublicKey(token2.originMint),
        notes: [{
          noteId: depositId2,
          spendingKey: blinding2,
          amount
        }],
        outputs: [{
          amount: 500000n,
          recipient,
          blinding: randomBlinding()
        }]
      }
    ]
  );
  
  console.info('[test-batch-transfer-size] ✓ Batch proof generated\n');
  
  // Prepare transfer data
  const nullifiers1 = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
  while (nullifiers1.length < 2) nullifiers1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputCommitments1 = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputCommitments1.length < 2) outputCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputAmountCommitments1 = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputAmountCommitments1.length < 2) outputAmountCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  
  const nullifiers2 = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
  while (nullifiers2.length < 2) nullifiers2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputCommitments2 = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputCommitments2.length < 2) outputCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputAmountCommitments2 = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputAmountCommitments2.length < 2) outputAmountCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  
  // Now check transaction size before sending
  console.info('[test-batch-transfer-size] Building transaction to check size...\n');
  
  try {
    // We'll try to build the transaction and check its size
    // We need to duplicate the logic from batchTransfer to check size
    
    // Import necessary functions
    const { BorshCoder } = await import('@coral-xyz/anchor');
    const poolIdl = await import('../idl/ptf_pool.json');
    const poolCoder = new BorshCoder(poolIdl.default as any);
    const { 
      deriveCommitmentTree, 
      deriveNullifierSet, 
      deriveNoteLedger,
      deriveMintMapping,
      deriveVerifyingKey
    } = await import('../lib/onchain/pdas');
    const { VERIFIER_PROGRAM_ID } = await import('../lib/onchain/programIds');
    const { fetchMintMappingAccount, ensureMintActive } = await import('../lib/sdk');
    const { 
      encodeFieldVector,
      canonicalHexToBytesLE,
      canonicalizeHex
    } = await import('../lib/sdk');
    const { SystemProgram, SYSVAR_RENT_PUBKEY } = await import('@solana/web3.js');
    const { ComputeBudgetProgram } = await import('@solana/web3.js');
    
    // Derive accounts (duplicate batchTransfer logic)
    const originMint0 = new PublicKey(token1.originMint);
    const poolState0Key = new PublicKey(token1.poolId);
    const originMint1 = new PublicKey(token2.originMint);
    const poolState1Key = new PublicKey(token2.poolId);
    
    const { decoded: mintMapping0 } = await fetchMintMappingAccount(connection, originMint0);
    const { decoded: mintMapping1 } = await fetchMintMappingAccount(connection, originMint1);
    ensureMintActive(mintMapping0);
    ensureMintActive(mintMapping1);
    
    const oldRoot0Bytes = canonicalHexToBytesLE(canonicalizeHex(batchProof.publicInputs[0]!));
    const newRoot0Bytes = canonicalHexToBytesLE(canonicalizeHex(batchProof.publicInputs[1]!));
    const oldRoot1Bytes = canonicalHexToBytesLE(canonicalizeHex(batchProof.publicInputs[8]!));
    const newRoot1Bytes = canonicalHexToBytesLE(canonicalizeHex(batchProof.publicInputs[9]!));
    
    const transferArgs0 = {
      old_root: Array.from(oldRoot0Bytes),
      new_root: Array.from(newRoot0Bytes),
      nullifiers: encodeFieldVector(nullifiers1.slice(0, 2), 'nullifiers'),
      output_commitments: encodeFieldVector(outputCommitments1.slice(0, 2), 'output_commitments'),
      output_amount_commitments: encodeFieldVector(outputAmountCommitments1.slice(0, 2), 'output_amount_commitments'),
      proof: Buffer.alloc(0),
      public_inputs: Buffer.alloc(0)
    };
    
    const transferArgs1 = {
      old_root: Array.from(oldRoot1Bytes),
      new_root: Array.from(newRoot1Bytes),
      nullifiers: encodeFieldVector(nullifiers2.slice(0, 2), 'nullifiers'),
      output_commitments: encodeFieldVector(outputCommitments2.slice(0, 2), 'output_commitments'),
      output_amount_commitments: encodeFieldVector(outputAmountCommitments2.slice(0, 2), 'output_amount_commitments'),
      proof: Buffer.alloc(0),
      public_inputs: Buffer.alloc(0)
    };
    
    const batchProofBytes = Buffer.from(batchProof.proof, 'base64');
    const batchPublicInputsBytes = Buffer.concat(
      batchProof.publicInputs.map(input => canonicalHexToBytesLE(canonicalizeHex(input)))
    );
    
    const batchTransferArgs = {
      transfers: [transferArgs0, transferArgs1],
      proof: Array.from(batchProofBytes),
      public_inputs: Array.from(batchPublicInputsBytes)
    };
    
    // Build instruction
    const instructionKeys = [
      { pubkey: poolState0Key, isSigner: false, isWritable: true },
      { pubkey: deriveNullifierSet(originMint0), isSigner: false, isWritable: true },
      { pubkey: deriveCommitmentTree(originMint0), isSigner: false, isWritable: true },
      { pubkey: deriveNoteLedger(originMint0), isSigner: false, isWritable: true },
      { pubkey: deriveMintMapping(originMint0), isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: deriveVerifyingKey(), isSigner: false, isWritable: false },
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      // Remaining accounts
      { pubkey: poolState1Key, isSigner: false, isWritable: true },
      { pubkey: deriveNullifierSet(originMint1), isSigner: false, isWritable: true },
      { pubkey: deriveCommitmentTree(originMint1), isSigner: false, isWritable: true },
      { pubkey: deriveNoteLedger(originMint1), isSigner: false, isWritable: true },
      { pubkey: deriveMintMapping(originMint1), isSigner: false, isWritable: false }
    ];
    
    const instructionData = poolCoder.instruction.encode('batch_private_transfer', { args: batchTransferArgs });
    
    const instruction = new TransactionInstruction({
      programId: (await import('../lib/onchain/programIds')).POOL_PROGRAM_ID,
      keys: instructionKeys,
      data: instructionData
    });
    
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
      instruction
    ];
    
    // Build transaction
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    }).compileToV0Message();
    
    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([user]);
    
    const serialized = versionedTx.serialize();
    
    console.info('='.repeat(60));
    console.info('TRANSACTION SIZE ANALYSIS');
    console.info('='.repeat(60));
    console.info(`Total transaction size: ${serialized.length} bytes`);
    console.info(`Instruction data size: ${instructionData.length} bytes`);
    console.info(`Number of accounts: ${instructionKeys.length}`);
    console.info('');
    console.info('SOLANA LIMITS:');
    console.info(`  Legacy Transaction: 1232 bytes max`);
    console.info(`  VersionedTransaction (V0): 1280 bytes max`);
    console.info('');
    
    if (serialized.length > 1280) {
      console.info('❌ TRANSACTION TOO LARGE!');
      console.info(`   Exceeds limit by ${serialized.length - 1280} bytes`);
      console.info('');
      console.info('RECOMMENDATION: Split batchTransfer into multiple transfer instructions');
      process.exit(1);
    } else if (serialized.length > 1232) {
      console.info('⚠️  TRANSACTION SIZE WARNING');
      console.info(`   Exceeds legacy limit (${serialized.length} > 1232), but within V0 limit`);
      console.info(`   Remaining headroom: ${1280 - serialized.length} bytes`);
      console.info('');
      console.info('STATUS: OK (uses VersionedTransaction)');
    } else {
      console.info('✓ TRANSACTION SIZE OK');
      console.info(`   Within legacy limit (${serialized.length} <= 1232)`);
      console.info(`   Remaining headroom: ${1232 - serialized.length} bytes`);
    }
    
    console.info('='.repeat(60));
    console.info('');
    
    // Also try sending it to see if it works
    console.info('[test-batch-transfer-size] Attempting to send transaction...');
    try {
      const sig = await connection.sendRawTransaction(serialized, {
        skipPreflight: false,
        maxRetries: 3
      });
      console.info(`[test-batch-transfer-size] ✓ Transaction sent successfully: ${sig}`);
      console.info('[test-batch-transfer-size] STATUS: batchTransfer works, no refactoring needed');
    } catch (error: any) {
      console.error(`[test-batch-transfer-size] ✗ Transaction failed: ${error.message}`);
      if (error.message && error.message.includes('too large')) {
        console.info('[test-batch-transfer-size] RECOMMENDATION: Split batchTransfer into multiple instructions');
        process.exit(1);
      }
      throw error;
    }
    
  } catch (error: any) {
    console.error(`[test-batch-transfer-size] ✗ Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);

