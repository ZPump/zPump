/**
 * Minimal test script to test Option 1: Lookup Table Compression for addDexLiquidity
 * This script assumes pools and tokens are already set up
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { addDexLiquidity } from '../lib/sdk';
import { ProofClient } from '../lib/proofClient';
import { createWalletAdapter } from './utils/walletAdapter';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';

async function main() {
  console.log('[test-add-liquidity-compression] Testing Option 1: Lookup Table Compression');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  // Use existing keys or generate new ones
  // For testing, you can provide existing token mints and pools
  const tokenA = process.env.TOKEN_A ? new PublicKey(process.env.TOKEN_A) : null;
  const tokenB = process.env.TOKEN_B ? new PublicKey(process.env.TOKEN_B) : null;
  
  if (!tokenA || !tokenB) {
    console.error('Please set TOKEN_A and TOKEN_B environment variables to existing token mints');
    console.error('Example: TOKEN_A=... TOKEN_B=... npx tsx test-add-liquidity-compression.ts');
    process.exit(1);
  }
  
  // Generate user keypair
  const user = Keypair.generate();
  const userAdapter = createWalletAdapter(user);
  
  console.log(`[test] User: ${user.publicKey.toBase58()}`);
  console.log(`[test] Token A: ${tokenA.toBase58()}`);
  console.log(`[test] Token B: ${tokenB.toBase58()}`);
  
  // Test addDexLiquidity with minimal amounts
  try {
    const signature = await addDexLiquidity({
      connection,
      wallet: userAdapter as any,
      tokenA: tokenA.toBase58(),
      tokenB: tokenB.toBase58(),
      amountA: 1000000n,
      amountB: 1000000n,
      minLpTokens: 0n,
      proofClient,
      zTokenNotesA: [], // Empty for now - would need actual notes
      zTokenNotesB: [], // Empty for now - would need actual notes
      keypair: user
    });
    
    console.log(`[test] ✓ addDexLiquidity succeeded: ${signature}`);
  } catch (error: any) {
    console.error(`[test] ✗ addDexLiquidity failed:`, error.message || error);
    process.exit(1);
  }
}

main().catch(console.error);


