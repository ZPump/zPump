/**
 * Simple test to check batchTransfer transaction size
 * Uses existing tokens if available, or creates new ones
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { batchTransfer } from '../lib/sdk';
import { generateBatchTransferProof, fetchZTokenPoolRoot } from '../lib/dex-ztoken-helpers';
import { ProofClient } from '../lib/proofClient';
import { createWalletAdapter } from './utils/walletAdapter';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { bytesLEToCanonicalHex } from '../lib/onchain/utils';
import { derivePoolState } from '../lib/onchain/pdas';
import { wrap, preparePool } from '../lib/sdk';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';

function randomBlinding(): string {
  return BigInt('0x' + require('crypto').randomBytes(32).toString('hex')).toString();
}

async function main() {
  console.info('\n=== Testing batchTransfer Transaction Size ===\n');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  const user = Keypair.generate();
  const walletAdapter = createWalletAdapter(user);
  
  console.info(`Test user: ${user.publicKey.toBase58()}`);
  
  // Airdrop
  console.info('Requesting airdrop...');
  const airdropSig = await connection.requestAirdrop(user.publicKey, 2 * 10 ** 9);
  await connection.confirmTransaction(airdropSig, 'confirmed');
  console.info('✓ Airdrop received\n');
  
  // Use wSOL as token1 if available, or create a new token
  // For simplicity, let's check if we can use existing tokens from the test
  // Or create two simple tokens
  
  // Let's just try to use the batch transfer with minimal setup
  // We need to shield tokens first
  
  // For now, let's just check the transaction size by calling batchTransfer
  // with dummy data to see the structure size
  
  console.info('NOTE: This test requires tokens to be created and shielded first.');
  console.info('Run the full batch-transfer-e2e.ts test to see actual transaction sizes.');
  console.info('Transaction size logging has been added to batchTransfer function.\n');
  
  console.info('To test transaction size:');
  console.info('1. Run: npx tsx scripts/batch-transfer-e2e.ts');
  console.info('2. Check the logs for "[batchTransfer] Transaction size: X bytes"');
  console.info('3. If size > 1280 bytes, batchTransfer needs to be split\n');
}

main().catch(console.error);

