/**
 * Test script for lazy initialization flow
 * Tests: mint token -> first shield (vault init + pool init + shield) -> subsequent shields
 * Follows the frontend flow by using the SDK functions directly
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { mintNativeZToken, wrap } from '../lib/sdk';
import { derivePoolState, deriveVaultState, deriveCommitmentTree } from '../lib/onchain/pdas';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const NEXT_URL = process.env.NEXT_URL ?? 'http://127.0.0.1:3000';

const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (2n * 10n ** 9n).toString());
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000'); // 1 token with 6 decimals

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function airdropSol(connection: Connection, address: PublicKey, amount: bigint): Promise<void> {
  const signature = await connection.requestAirdrop(address, Number(amount));
  await connection.confirmTransaction(signature, 'confirmed');
  const balance = await connection.getBalance(address);
  if (balance < Number(amount)) {
    throw new Error(`Airdrop failed: expected ${amount}, got ${balance}`);
  }
  console.info(`[test] Airdropped ${amount} lamports to ${address.toBase58()}`);
}

async function waitForAccount(connection: Connection, address: PublicKey, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const account = await connection.getAccountInfo(address, 'confirmed');
    if (account) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for account ${address.toBase58()}`);
}

async function testLazyInitialization(): Promise<void> {
  console.info('[test] Starting lazy initialization test...');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();
  
  // Step 1: Airdrop SOL to payer
  console.info('[test] Step 1: Airdropping SOL to payer...');
  await airdropSol(connection, payer.publicKey, SOL_AIRDROP_LAMPORTS);
  
  // Step 2: Mint a new token (should NOT initialize pool/vault)
  console.info('[test] Step 2: Minting new token...');
  const mintResult = await mintNativeZToken({
    wallet: {
      publicKey: payer.publicKey,
      signTransaction: async (tx: any) => {
        tx.sign(payer);
        return tx;
      },
      signAllTransactions: async (txs: any[]) => {
        return txs.map(tx => {
          tx.sign(payer);
          return tx;
        });
      }
    } as any,
    connection,
    name: 'Test Token',
    symbol: 'TEST',
    uri: 'https://test.com',
    decimals: 6,
    initialSupply: BigInt('1000000000'), // 1000 tokens
    featureFlags: undefined,
    feeBpsOverride: undefined
  });
  
  console.info(`[test] Token minted: ${mintResult.originMint}`);
  console.info(`[test] Pool ID: ${mintResult.poolId}`);
  
  // Step 3: Verify pool/vault are NOT initialized
  console.info('[test] Step 3: Verifying pool/vault are NOT initialized...');
  const originMintKey = new PublicKey(mintResult.originMint);
  const poolState = derivePoolState(originMintKey);
  const vaultState = deriveVaultState(originMintKey);
  
  const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
  const vaultAccount = await connection.getAccountInfo(vaultState, 'confirmed');
  
  if (poolAccount) {
    throw new Error('Pool should not be initialized after minting');
  }
  if (vaultAccount) {
    throw new Error('Vault should not be initialized after minting');
  }
  console.info('[test] ✓ Pool and vault are not initialized (as expected)');
  
  // Step 4: First shield (should initialize vault + pool + shield)
  console.info('[test] Step 4: Performing first shield (lazy initialization)...');
  
  // Generate proof (simplified - in real flow this comes from proof service)
  // For testing, we'll use a mock proof or call the proof API
  const proofResponse = await fetch(`${PROOF_URL}/prove/shield`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      circuit: 'wrap',
      payload: {
        amount: WRAP_AMOUNT.toString(),
        recipient: payer.publicKey.toBase58(),
        depositId: Date.now().toString(),
        blinding: Math.floor(Math.random() * 10 ** 18).toString(),
        originMint: mintResult.originMint,
        poolId: mintResult.poolId
      }
    })
  });
  
  if (!proofResponse.ok) {
    throw new Error(`Proof generation failed: ${proofResponse.statusText}`);
  }
  
  const proof = await proofResponse.json();
  
  const shieldSignature = await wrap({
    wallet: {
      publicKey: payer.publicKey,
      signTransaction: async (tx: any) => {
        tx.sign(payer);
        return tx;
      },
      signAllTransactions: async (txs: any[]) => {
        return txs.map(tx => {
          tx.sign(payer);
          return tx;
        });
      }
    } as any,
    connection,
    originMint: mintResult.originMint,
    poolId: mintResult.poolId,
    amount: WRAP_AMOUNT.toString(),
    recipient: payer.publicKey.toBase58(),
    depositId: Date.now().toString(),
    blinding: Math.floor(Math.random() * 10 ** 18).toString(),
    proof: proof
  });
  
  console.info(`[test] First shield signature: ${shieldSignature}`);
  
  // Step 5: Verify pool/vault ARE now initialized
  console.info('[test] Step 5: Verifying pool/vault are now initialized...');
  await waitForAccount(connection, poolState, 30000);
  await waitForAccount(connection, vaultState, 30000);
  
  const poolAccountAfter = await connection.getAccountInfo(poolState, 'confirmed');
  const vaultAccountAfter = await connection.getAccountInfo(vaultState, 'confirmed');
  
  if (!poolAccountAfter) {
    throw new Error('Pool should be initialized after first shield');
  }
  if (!vaultAccountAfter) {
    throw new Error('Vault should be initialized after first shield');
  }
  console.info('[test] ✓ Pool and vault are initialized');
  
  // Step 6: Second shield (should NOT re-initialize, just shield)
  console.info('[test] Step 6: Performing second shield (no initialization)...');
  
  const proof2Response = await fetch(`${PROOF_URL}/prove/shield`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      circuit: 'wrap',
      payload: {
        amount: WRAP_AMOUNT.toString(),
        recipient: payer.publicKey.toBase58(),
        depositId: Date.now().toString(),
        blinding: Math.floor(Math.random() * 10 ** 18).toString(),
        originMint: mintResult.originMint,
        poolId: mintResult.poolId
      }
    })
  });
  
  if (!proof2Response.ok) {
    throw new Error(`Proof generation failed: ${proof2Response.statusText}`);
  }
  
  const proof2 = await proof2Response.json();
  
  const shield2Signature = await wrap({
    wallet: {
      publicKey: payer.publicKey,
      signTransaction: async (tx) => {
        tx.sign(payer);
        return tx;
      },
      signAllTransactions: async (txs) => {
        return txs.map(tx => {
          tx.sign(payer);
          return tx;
        });
      }
    } as any,
    connection,
    originMint: mintResult.originMint,
    poolId: mintResult.poolId,
    amount: WRAP_AMOUNT.toString(),
    recipient: payer.publicKey.toBase58(),
    depositId: Date.now().toString(),
    blinding: Math.floor(Math.random() * 10 ** 18).toString(),
    proof: proof2
  });
  
  console.info(`[test] Second shield signature: ${shield2Signature}`);
  console.info('[test] ✓ Second shield completed (no re-initialization)');
  
  console.info('[test] ✅ All lazy initialization tests passed!');
}

async function main() {
  try {
    await testLazyInitialization();
    process.exit(0);
  } catch (error) {
    console.error('[test] ❌ Test failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { testLazyInitialization };

