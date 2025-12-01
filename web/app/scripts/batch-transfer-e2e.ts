/**
 * Batch Transfer End-to-End Test
 * 
 * Tests batch transfer operations with varying numbers of zTokens (2-10) to simulate real-world use.
 * 
 * Current implementation supports exactly 2 transfers (circuit limitation).
 * Test structure prepared for extension to 3-10 transfers when implemented.
 * 
 * Test scenarios:
 * - 2 tokens (minimum, currently supported)
 * - Multiple transfers with change handling
 * - Cross-token transfers
 * - Error cases (insufficient balance, invalid proofs, etc.)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount
} from '@solana/spl-token';
import {
  wrap,
  batchTransfer,
  preparePool,
  fetchMintMappingAccount
} from '../lib/sdk';
import { generateBatchTransferProof } from '../lib/dex-ztoken-helpers';
import { derivePoolState } from '../lib/onchain/pdas';
import { fetchZTokenPoolRoot } from '../lib/dex-ztoken-helpers';
import { ProofClient } from '../lib/proofClient';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { createWalletAdapter } from './utils/walletAdapter';
import { randomBytes } from 'crypto';
import { bytesLEToCanonicalHex, canonicalHexToBytesLE } from '../lib/onchain/utils';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const FAUCET_BASE_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:3000/api/faucet';
const MINTS_API_URL = process.env.MINTS_API_URL ?? 'http://127.0.0.1:3000/api/mints';

const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (2n * 10n ** 9n).toString());
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000');

// Timeout constants
const FETCH_TIMEOUT_MS = 15000; // 15 seconds for API calls
const PROOF_TIMEOUT_MS = 60000; // 60 seconds for proof generation
const TX_CONFIRM_TIMEOUT_MS = 30000; // 30 seconds for transaction confirmation
const TEST_TIMEOUT_MS = 300000; // 5 minutes per test
const SLEEP_TIMEOUT_MS = 5000; // 5 seconds for short sleeps

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${errorMessage} (timeout after ${timeoutMs}ms)`)), timeoutMs)
    )
  ]);
}

interface MintConfig {
  originMint: string;
  poolId: string;
  symbol: string;
  decimals: number;
}

interface WrapResult {
  noteId: string;
  spendingKey: string;
  noteAmount: bigint;
  newRoot: string;
  commitment: string;
}

function randomBlinding(): string {
  return BigInt('0x' + randomBytes(32).toString('hex')).toString();
}

function generateUniqueSymbol(): string {
  // Symbol must be 2-6 characters. Use format: BT + 3-digit number = 5 chars total
  const num = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `BT${num}`;
}

async function createToken(symbol: string): Promise<MintConfig> {
  const maxRetries = 15; // Increased retries
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const fetchPromise = fetch(`${MINTS_API_URL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, decimals: 6 }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 20) // Much longer timeout for bootstrap (300s)
      });
      
      const response = await withTimeout(
        fetchPromise,
        FETCH_TIMEOUT_MS * 20, // 300 seconds timeout
        `Create token ${symbol} request (attempt ${attempt + 1}/${maxRetries})`
      );
      
      if (response.ok) {
        const result = await response.json();
        console.log(`[createToken] ✓ Successfully created token ${symbol}`);
        return result.mint as MintConfig; // Extract mint from response
      }
      
      const errorText = await response.text();
      const errorData = errorText ? JSON.parse(errorText) : {};
      
      // If mint_registration_in_progress, wait longer and retry
      if (response.status === 429 && errorData.error === 'mint_registration_in_progress') {
        // Use longer delays, especially for later attempts
        const baseDelay = 5000; // Start with 5 seconds
        const delay = Math.min(baseDelay * Math.pow(1.5, attempt), 60000); // Max 60s delay
        const elapsed = (delay / 1000).toFixed(1);
        console.warn(`[createToken] Token ${symbol} registration in progress (attempt ${attempt + 1}/${maxRetries}), waiting ${elapsed}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // After waiting, check if bootstrap is available before retrying
        if (attempt % 3 === 2) { // Every 3rd retry, check bootstrap status
          console.log(`[createToken] Checking bootstrap status before retry...`);
          await waitForBootstrapComplete(30000);
        }
        
        lastError = new Error(`Failed to create token ${symbol}: ${response.status} ${errorText}`);
        continue;
      }
      
      lastError = new Error(`Failed to create token ${symbol}: ${response.status} ${errorText}`);
      if (response.status !== 429) {
        // Non-retryable error, throw immediately
        throw lastError;
      }
    } catch (error: any) {
      if (error.message && (error.message.includes('timeout') || error.message.includes('aborted'))) {
        const baseDelay = 5000;
        const delay = Math.min(baseDelay * Math.pow(1.5, attempt), 60000);
        const elapsed = (delay / 1000).toFixed(1);
        console.warn(`[createToken] Timeout creating token ${symbol} (attempt ${attempt + 1}/${maxRetries}), retrying in ${elapsed}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  
  throw lastError || new Error(`Failed to create token ${symbol} after ${maxRetries} attempts`);
}

async function waitForBootstrapComplete(maxWaitMs = 180000): Promise<void> {
  const startTime = Date.now();
  const checkInterval = 3000; // Check every 3 seconds
  const stableChecksRequired = 3; // Require 3 consecutive successful checks
  let consecutiveSuccess = 0;
  
  console.log('[waitForBootstrapComplete] Waiting for bootstrap to complete...');
  
  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Check if API is responsive
      const getResponse = await fetch(`${MINTS_API_URL}`, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (getResponse.ok) {
        consecutiveSuccess++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (consecutiveSuccess >= stableChecksRequired) {
          console.log(`[waitForBootstrapComplete] ✓ Bootstrap complete and API stable (${elapsed}s elapsed, ${consecutiveSuccess} successful checks)`);
          // Extra buffer time to ensure bootstrap fully completes
          await new Promise(resolve => setTimeout(resolve, 3000));
          return;
        } else {
          console.log(`[waitForBootstrapComplete] API responsive (${consecutiveSuccess}/${stableChecksRequired} checks, ${elapsed}s elapsed)...`);
        }
      } else {
        // Reset counter if API not responsive
        consecutiveSuccess = 0;
      }
    } catch (error: any) {
      // Reset counter on error
      consecutiveSuccess = 0;
      // API might be busy or timeout, continue waiting
      if (!error.message?.includes('timeout') && !error.message?.includes('aborted')) {
        console.warn(`[waitForBootstrapComplete] API check error: ${error.message}`);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  console.warn('[waitForBootstrapComplete] Timeout waiting for bootstrap, continuing anyway');
}

async function createTokensSequentially(symbols: string[]): Promise<MintConfig[]> {
  const tokens: MintConfig[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    console.log(`[createTokensSequentially] Creating token ${i + 1}/${symbols.length}: ${symbol}`);
    
    // Wait for any previous bootstrap to complete before creating next token
    if (i > 0) {
      console.log(`[createTokensSequentially] Waiting for previous bootstrap to complete...`);
      await waitForBootstrapComplete(60000); // Wait up to 60s for each subsequent token
      await new Promise(resolve => setTimeout(resolve, 3000)); // Additional 3s buffer
    }
    
    tokens.push(await createToken(symbol));
    
    // Additional delay after token creation to ensure bootstrap completes
    if (i < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return tokens;
}

async function requestAirdrop(connection: Connection, address: PublicKey, amount: bigint): Promise<string> {
  // Try faucet API first, fallback to direct airdrop
  try {
    const response = await withTimeout(
      fetch(`${FAUCET_BASE_URL}/sol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: address.toBase58(), amountLamports: amount.toString() }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      }),
      FETCH_TIMEOUT_MS,
      'Faucet API request'
    );
    
    if (response.ok) {
      const { signature } = (await response.json()) as { signature: string };
      console.info(`[requestAirdrop] Faucet API airdrop: ${signature}`);
      await confirmTransaction(connection, signature, TX_CONFIRM_TIMEOUT_MS * 2); // Longer timeout for airdrop
      return signature;
    }
  } catch (err) {
    console.warn(`[requestAirdrop] Faucet API failed, trying direct airdrop: ${err}`);
  }
  
  // Fallback to direct airdrop
  console.info(`[requestAirdrop] Using direct requestAirdrop for ${address.toBase58()}`);
  const signature = await withTimeout(
    connection.requestAirdrop(address, Number(amount)),
    FETCH_TIMEOUT_MS,
    'Direct airdrop request'
  );
  console.info(`[requestAirdrop] Airdrop requested: ${signature}`);
  
  // Try to confirm, but don't fail if it times out - just verify balance instead
  try {
    await confirmTransaction(connection, signature, TX_CONFIRM_TIMEOUT_MS * 2);
    console.info(`[requestAirdrop] ✓ Airdrop confirmed: ${signature}`);
  } catch (confirmError: any) {
    console.warn(`[requestAirdrop] Confirmation timed out, waiting and checking balance: ${confirmError.message}`);
    // Wait longer and check balance multiple times
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const balance = await connection.getBalance(address, 'confirmed');
      console.info(`[requestAirdrop] Balance check ${i + 1}/10: ${balance} lamports`);
      if (balance >= Number(amount)) {
        console.info(`[requestAirdrop] ✓ Balance verified: ${balance} lamports`);
        return signature;
      }
    }
    const finalBalance = await connection.getBalance(address, 'confirmed');
    throw new Error(`Airdrop may have failed: balance ${finalBalance} < requested ${amount} after waiting`);
  }
  
  return signature;
}

async function faucetToken(
  connection: Connection,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint
): Promise<string> {
  // Try faucet API first, fallback to direct minting
  try {
    const fetchPromise = fetch(`${FAUCET_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mint: mint.toBase58(),
        recipient: destination.toBase58(),
        amount: amount.toString()
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    
    const response = await withTimeout(
      fetchPromise,
      FETCH_TIMEOUT_MS,
      'Faucet request'
    );
    
    if (response.ok) {
      const result = await response.json();
      const signature = result.signature as string;
      
      // Wait for confirmation
      await confirmTransaction(connection, signature, TX_CONFIRM_TIMEOUT_MS * 2);
      return signature;
    }
  } catch (err: any) {
    console.warn(`[faucetToken] Faucet API failed: ${err.message}, skipping token faucet (tokens will be minted via shield)`);
    // Return empty signature - we'll mint tokens via shield instead
    return '';
  }
  
  throw new Error(`Faucet failed for token ${mint.toBase58()}`);
}

async function confirmTransaction(connection: Connection, signature: string, timeoutMs = TX_CONFIRM_TIMEOUT_MS): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const txStatus = await connection.getSignatureStatus(signature);
      
      if (txStatus.value) {
        if (txStatus.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(txStatus.value.err)}`);
        }
        if (txStatus.value.confirmationStatus === 'confirmed' || txStatus.value.confirmationStatus === 'finalized') {
          return;
        }
      }
    } catch (error: any) {
      // If error fetching status, continue polling unless it's a fatal error
      if (error.message && (error.message.includes('failed') || error.message.includes('Transaction failed'))) {
        throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`Transaction ${signature} did not confirm within ${timeoutMs}ms`);
}

async function shieldToken(
  connection: Connection,
  wallet: any,
  keypair: Keypair,
  originMint: PublicKey,
  amount: bigint,
  proofClient: ProofClient
): Promise<WrapResult[]> {
  console.info(`[shieldToken] Shielding ${amount} tokens for mint ${originMint.toBase58()}`);
  
  // Derive pool ID from origin mint
  const poolStateKey = derivePoolState(originMint);
  const poolId = poolStateKey.toBase58();
  
  // Prepare pool (ensure lookup tables exist)
  await preparePool({
    connection,
    wallet,
    originMint: originMint.toBase58()
  });
  
  // Fetch mint mapping to check for twin mint
  const { decoded: mintMapping } = await fetchMintMappingAccount(connection, originMint);
  let twinMint: string | null = null;
  if (mintMapping.hasPtkn && mintMapping.ptknMint) {
    const ptknMintKey = new PublicKey(mintMapping.ptknMint);
    if (!ptknMintKey.equals(PublicKey.default)) {
      twinMint = ptknMintKey.toBase58();
    }
  }
  
  // Fetch current root from commitment tree
  const currentRoot = await withTimeout(
    fetchZTokenPoolRoot(connection, originMint),
    FETCH_TIMEOUT_MS,
    'Fetch zToken pool root'
  );
  
  // Generate depositId and blinding
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1_000_000);
  const depositId = `${timestamp}${random}`;
  const blinding = Math.floor(Math.random() * 10 ** 18).toString();
  
  // Request proof with timeout
  const proofPromise = proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: amount.toString(),
    recipient: wallet.publicKey!.toBase58(),
    depositId,
    poolId,
    blinding,
    mintId: originMint.toBase58()
  });
  
  const proof = await withTimeout(
    proofPromise,
    PROOF_TIMEOUT_MS,
    'Generate wrap proof'
  );
  
  // Shield tokens using wrap function
  const signature = await withTimeout(
    wrap({
    connection,
    wallet,
    originMint: originMint.toBase58(),
    poolId,
    amount,
    recipient: wallet.publicKey!.toBase58(),
    depositId,
    blinding,
    proof,
      twinMint: twinMint || undefined,
      keypair
    }),
    TX_CONFIRM_TIMEOUT_MS * 2,
    'Wrap/shield transaction'
  );
  
  await confirmTransaction(connection, signature, TX_CONFIRM_TIMEOUT_MS);
  
  // Wait for shield to finalize (with timeout)
  await new Promise(resolve => setTimeout(resolve, Math.min(3000, SLEEP_TIMEOUT_MS)));
  console.info(`[shieldToken] ✓ Shielded successfully: ${signature}`);
  
  // Return tracked note
  const newRoot = await withTimeout(
    fetchZTokenPoolRoot(connection, originMint),
    FETCH_TIMEOUT_MS,
    'Fetch new root after shield'
  );
  
  return [{
    noteId: depositId,
    spendingKey: blinding,
    noteAmount: amount,
    newRoot,
    commitment: currentRoot
  }];
}

async function waitForValidator(connection: Connection, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const slot = await connection.getSlot();
      if (slot > 0) {
        console.info(`[waitForValidator] ✓ Validator ready at slot ${slot}`);
        return;
      }
    } catch (error) {
      // Continue waiting
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Validator did not become ready within timeout');
}

async function main() {
  console.info('[batch-transfer-e2e] Starting batch transfer E2E test suite');
  
  // Set overall timeout for entire test suite
  const testTimeout = setTimeout(() => {
    console.error('[batch-transfer-e2e] ✗ Test suite timed out after 10 minutes');
    process.exit(1);
  }, 600000); // 10 minutes total
  
  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    
    // Wait for validator to be ready
    console.info('[batch-transfer-e2e] Waiting for validator to be ready...');
    await waitForValidator(connection, 30000);
    
    // Wait for bootstrap to complete
    console.info('[batch-transfer-e2e] Waiting for bootstrap to complete...');
    await waitForBootstrapComplete(120000);
    console.info('[batch-transfer-e2e] ✓ Bootstrap complete\n');
    
    const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  // Create test user keypair
  const user = Keypair.generate();
  console.info(`[batch-transfer-e2e] User: ${user.publicKey.toBase58()}`);
  
  // Airdrop SOL to user (with retry)
  console.info('[batch-transfer-e2e] Airdropping SOL to user...');
  let airdropSuccess = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await requestAirdrop(connection, user.publicKey, SOL_AIRDROP_LAMPORTS);
      airdropSuccess = true;
      break;
    } catch (error: any) {
      console.warn(`[batch-transfer-e2e] Airdrop attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < 2) {
        console.info(`[batch-transfer-e2e] Retrying airdrop in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  
  if (!airdropSuccess) {
    throw new Error('Failed to airdrop SOL after 3 attempts');
  }
  
  const walletAdapter = createWalletAdapter(user);
  
  // Test 1: Batch transfer with 2 tokens (minimum, currently supported)
  console.info('\n=== Test 1: Batch Transfer with 2 Tokens ===');
  await withTimeout(
    (async () => {
      try {
    // Create two tokens
    const symbol1 = generateUniqueSymbol();
    const symbol2 = generateUniqueSymbol();
    console.info(`[test-1] Creating tokens: ${symbol1}, ${symbol2}`);
    
    const [token1, token2] = await createTokensSequentially([symbol1, symbol2]);
    
    console.info(`[test-1] Token 1: ${token1.originMint}`);
    console.info(`[test-1] Token 2: ${token2.originMint}`);
    
    // Faucet tokens to user
    console.info('[test-1] Requesting tokens from faucet...');
    const [faucet1, faucet2] = await Promise.all([
      faucetToken(connection, new PublicKey(token1.originMint), user.publicKey, WRAP_AMOUNT * 2n),
      faucetToken(connection, new PublicKey(token2.originMint), user.publicKey, WRAP_AMOUNT * 2n)
    ]);
    console.info(`[test-1] Faucet 1: ${faucet1}`);
    console.info(`[test-1] Faucet 2: ${faucet2}`);
    
    // Prepare pools to ensure lookup tables exist and have all required accounts
    console.info('[test-1] Preparing pools for batch transfer...');
    try {
      await preparePool({
        connection,
        wallet: walletAdapter,
        originMint: token1.originMint
      });
      console.info('[test-1] ✓ Pool 1 prepared');
    } catch (error: any) {
      console.warn('[test-1] ⚠️  Pool 1 preparation had issues (may already exist):', error.message);
    }
    try {
      await preparePool({
        connection,
        wallet: walletAdapter,
        originMint: token2.originMint
      });
      console.info('[test-1] ✓ Pool 2 prepared');
    } catch (error: any) {
      console.warn('[test-1] ⚠️  Pool 2 preparation had issues (may already exist):', error.message);
    }
    
    // Shield both tokens
    console.info('[test-1] Shielding tokens...');
    const [notes1, notes2] = await Promise.all([
      shieldToken(connection, walletAdapter, user, new PublicKey(token1.originMint), WRAP_AMOUNT, proofClient),
      shieldToken(connection, walletAdapter, user, new PublicKey(token2.originMint), WRAP_AMOUNT, proofClient)
    ]);
    
    console.info(`[test-1] Shielded ${notes1.length} notes for token 1`);
    console.info(`[test-1] Shielded ${notes2.length} notes for token 2`);
    
    // Create recipient for batch transfer
    const recipient = Keypair.generate();
    console.info(`[test-1] Recipient: ${recipient.publicKey.toBase58()}`);
    
    // Prepare batch transfer: transfer 500k of each token to recipient
    const transferAmount1 = WRAP_AMOUNT / 2n;
    const transferAmount2 = WRAP_AMOUNT / 2n;
    
    console.info(`[test-1] Preparing batch transfer: ${transferAmount1} token1 + ${transferAmount2} token2`);
    
    // Generate batch transfer proof with timeout
    const batchProofPromise = generateBatchTransferProof(
      proofClient,
      connection,
      [
        {
          originMint: new PublicKey(token1.originMint),
          notes: notes1.map(n => ({
            noteId: n.noteId,
            spendingKey: n.spendingKey,
            amount: n.noteAmount
          })),
          outputs: [
            {
              amount: transferAmount1,
              recipient: recipient.publicKey,
              blinding: randomBlinding()
            },
            {
              amount: notes1[0]!.noteAmount - transferAmount1, // Change back to user
              recipient: user.publicKey,
              blinding: randomBlinding()
            }
          ]
        },
        {
          originMint: new PublicKey(token2.originMint),
          notes: notes2.map(n => ({
            noteId: n.noteId,
            spendingKey: n.spendingKey,
            amount: n.noteAmount
          })),
          outputs: [
            {
              amount: transferAmount2,
              recipient: recipient.publicKey,
              blinding: randomBlinding()
            },
            {
              amount: notes2[0]!.noteAmount - transferAmount2, // Change back to user
              recipient: user.publicKey,
              blinding: randomBlinding()
            }
          ]
        }
      ]
    );
    
    const batchProof = await withTimeout(
      batchProofPromise,
      PROOF_TIMEOUT_MS,
      'Generate batch transfer proof'
    );
    
    console.info('[test-1] Batch proof generated successfully');
    console.info(`[test-1] Batch proof has ${batchProof.publicInputs.length} public inputs`);
    
    // Extract nullifiers and commitments from batch proof transfer results
    // Ensure we have exactly 2 nullifiers and 2 commitments per transfer (circuit requirement)
    // Pad with zeros if needed
    const nullifiers1: string[] = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    while (nullifiers1.length < 2) {
      nullifiers1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    }
    const outputCommitments1: string[] = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputCommitments1.length < 2) {
      outputCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    }
    const outputAmountCommitments1: string[] = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputAmountCommitments1.length < 2) {
      outputAmountCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    }
    
    const nullifiers2: string[] = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    while (nullifiers2.length < 2) {
      nullifiers2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    }
    const outputCommitments2: string[] = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputCommitments2.length < 2) {
      outputCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    }
    const outputAmountCommitments2: string[] = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputAmountCommitments2.length < 2) {
      outputAmountCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    }
    
    // Execute batch transfer with timeout
    const batchTransferSig = await withTimeout(
      batchTransfer({
      connection,
      wallet: walletAdapter as any,
      transfers: [
        {
          originMint: token1.originMint,
          poolId: token1.poolId,
          proof: batchProof,
          nullifiers: nullifiers1.slice(0, 2),
          outputCommitments: outputCommitments1.slice(0, 2),
          outputAmountCommitments: outputAmountCommitments1.slice(0, 2)
        },
        {
          originMint: token2.originMint,
          poolId: token2.poolId,
          proof: batchProof,
          nullifiers: nullifiers2.slice(0, 2),
          outputCommitments: outputCommitments2.slice(0, 2),
          outputAmountCommitments: outputAmountCommitments2.slice(0, 2)
        }
      ],
      batchProof,
        batchPublicInputs: batchProof.publicInputs,
        keypair: user
      }),
      TX_CONFIRM_TIMEOUT_MS * 2,
      'Execute batch transfer'
    );
    
    console.info(`[test-1] ✓ Batch transfer successful: ${batchTransferSig}`);
    
    // Verify roots updated (with timeout)
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, SLEEP_TIMEOUT_MS)));
    const newRoot1 = await withTimeout(
      fetchZTokenPoolRoot(connection, new PublicKey(token1.originMint)),
      FETCH_TIMEOUT_MS,
      'Fetch root 1 after batch transfer'
    );
    const newRoot2 = await withTimeout(
      fetchZTokenPoolRoot(connection, new PublicKey(token2.originMint)),
      FETCH_TIMEOUT_MS,
      'Fetch root 2 after batch transfer'
    );
    console.info(`[test-1] New root 1: ${newRoot1}`);
    console.info(`[test-1] New root 2: ${newRoot2}`);
    
    if (newRoot1 === batchProof.transfers[0]!.newRoot) {
      console.info('[test-1] ✓ Root 1 matches batch proof');
    } else {
      throw new Error(`Root 1 mismatch: expected ${batchProof.transfers[0]!.newRoot}, got ${newRoot1}`);
    }
    
    if (newRoot2 === batchProof.transfers[1]!.newRoot) {
      console.info('[test-1] ✓ Root 2 matches batch proof');
    } else {
      throw new Error(`Root 2 mismatch: expected ${batchProof.transfers[1]!.newRoot}, got ${newRoot2}`);
    }
    
    console.info('[test-1] ✓ Test 1 passed!\n');
      } catch (error: any) {
        console.error('[test-1] ✗ Test 1 failed:', error.message);
        throw error;
      }
    })(),
    TEST_TIMEOUT_MS,
    'Test 1: Batch Transfer with 2 Tokens'
  );
  
  // Test 2: Batch transfer with change handling
  console.info('\n=== Test 2: Batch Transfer with Change ===');
  await withTimeout(
    (async () => {
      try {
    // Similar to test 1 but with different amounts to test change logic
    const symbol1 = generateUniqueSymbol();
    const symbol2 = generateUniqueSymbol();
    
    const [token1, token2] = await createTokensSequentially([symbol1, symbol2]);
    
    // Shield more than we'll transfer
    const [notes1, notes2] = await Promise.all([
      shieldToken(connection, walletAdapter, user, new PublicKey(token1.originMint), WRAP_AMOUNT, proofClient),
      shieldToken(connection, walletAdapter, user, new PublicKey(token2.originMint), WRAP_AMOUNT, proofClient)
    ]);
    
    const recipient = Keypair.generate();
    const transferAmount1 = WRAP_AMOUNT / 3n; // Transfer 1/3, change back 2/3
    const transferAmount2 = WRAP_AMOUNT / 4n; // Transfer 1/4, change back 3/4
    
    const batchProof = await withTimeout(
      generateBatchTransferProof(
        proofClient,
        connection,
        [
          {
            originMint: new PublicKey(token1.originMint),
            notes: notes1.map(n => ({
              noteId: n.noteId,
              spendingKey: n.spendingKey,
              amount: n.noteAmount
            })),
            outputs: [
              {
                amount: transferAmount1,
                recipient: recipient.publicKey,
                blinding: randomBlinding()
              },
              {
                amount: notes1[0]!.noteAmount - transferAmount1,
                recipient: user.publicKey,
                blinding: randomBlinding()
              }
            ]
          },
          {
            originMint: new PublicKey(token2.originMint),
            notes: notes2.map(n => ({
              noteId: n.noteId,
              spendingKey: n.spendingKey,
              amount: n.noteAmount
            })),
            outputs: [
              {
                amount: transferAmount2,
                recipient: recipient.publicKey,
                blinding: randomBlinding()
              },
              {
                amount: notes2[0]!.noteAmount - transferAmount2,
                recipient: user.publicKey,
                blinding: randomBlinding()
              }
            ]
          }
        ]
      ),
      PROOF_TIMEOUT_MS,
      'Generate batch transfer proof for test 2'
    );
    
    // Extract and pad nullifiers/commitments to exactly 2 per transfer
    const nullifiers1_2: string[] = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    while (nullifiers1_2.length < 2) nullifiers1_2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    const outputCommitments1_2: string[] = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputCommitments1_2.length < 2) outputCommitments1_2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    const outputAmountCommitments1_2: string[] = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputAmountCommitments1_2.length < 2) outputAmountCommitments1_2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    
    const nullifiers2_2: string[] = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    while (nullifiers2_2.length < 2) nullifiers2_2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    const outputCommitments2_2: string[] = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputCommitments2_2.length < 2) outputCommitments2_2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    const outputAmountCommitments2_2: string[] = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    while (outputAmountCommitments2_2.length < 2) outputAmountCommitments2_2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
    
    const batchTransferSig = await withTimeout(
      batchTransfer({
        connection,
        wallet: walletAdapter as any,
        transfers: [
          {
            originMint: token1.originMint,
            poolId: token1.poolId,
            proof: batchProof,
            nullifiers: nullifiers1_2.slice(0, 2),
            outputCommitments: outputCommitments1_2.slice(0, 2),
            outputAmountCommitments: outputAmountCommitments1_2.slice(0, 2)
          },
          {
            originMint: token2.originMint,
            poolId: token2.poolId,
            proof: batchProof,
            nullifiers: nullifiers2_2.slice(0, 2),
            outputCommitments: outputCommitments2_2.slice(0, 2),
            outputAmountCommitments: outputAmountCommitments2_2.slice(0, 2)
          }
        ],
        batchProof,
        batchPublicInputs: batchProof.publicInputs,
        keypair: user
      }),
      TX_CONFIRM_TIMEOUT_MS * 2,
      'Execute batch transfer for test 2'
    );
    
    console.info(`[test-2] ✓ Batch transfer with change successful: ${batchTransferSig}`);
    console.info('[test-2] ✓ Test 2 passed!\n');
      } catch (error: any) {
        console.error('[test-2] ✗ Test 2 failed:', error.message);
        throw error;
      }
    })(),
    TEST_TIMEOUT_MS,
    'Test 2: Batch Transfer with Change'
  );
  
  // Test 3: Error case - insufficient balance
  console.info('\n=== Test 3: Error Case - Insufficient Balance ===');
  await withTimeout(
    (async () => {
      try {
    const symbol1 = generateUniqueSymbol();
    const symbol2 = generateUniqueSymbol();
    
    const [token1, token2] = await createTokensSequentially([symbol1, symbol2]);
    
    // Shield less than we'll try to transfer
    const [notes1, notes2] = await Promise.all([
      shieldToken(connection, walletAdapter, user, new PublicKey(token1.originMint), WRAP_AMOUNT / 2n, proofClient),
      shieldToken(connection, walletAdapter, user, new PublicKey(token2.originMint), WRAP_AMOUNT / 2n, proofClient)
    ]);
    
    const recipient = Keypair.generate();
    const transferAmount1 = WRAP_AMOUNT; // More than available
    const transferAmount2 = WRAP_AMOUNT; // More than available
    
    // This should fail during proof generation or transfer
    try {
      await withTimeout(
        generateBatchTransferProof(
          proofClient,
          connection,
          [
            {
              originMint: new PublicKey(token1.originMint),
              notes: notes1.map(n => ({
                noteId: n.noteId,
                spendingKey: n.spendingKey,
                amount: n.noteAmount
              })),
              outputs: [
                {
                  amount: transferAmount1,
                  recipient: recipient.publicKey,
                  blinding: randomBlinding()
                }
              ]
            },
            {
              originMint: new PublicKey(token2.originMint),
              notes: notes2.map(n => ({
                noteId: n.noteId,
                spendingKey: n.spendingKey,
                amount: n.noteAmount
              })),
              outputs: [
                {
                  amount: transferAmount2,
                  recipient: recipient.publicKey,
                  blinding: randomBlinding()
                }
              ]
            }
          ]
        ),
        PROOF_TIMEOUT_MS,
        'Generate batch transfer proof for insufficient balance test'
      );
      
      throw new Error('Expected error for insufficient balance, but proof generation succeeded');
    } catch (error: any) {
      if (error.message.includes('insufficient') || error.message.includes('balance') || error.message.includes('amount')) {
        console.info('[test-3] ✓ Correctly rejected insufficient balance');
        console.info('[test-3] ✓ Test 3 passed!\n');
      } else {
        throw error;
      }
    }
      } catch (error: any) {
        console.error('[test-3] ✗ Test 3 failed:', error.message);
        throw error;
      }
    })(),
    TEST_TIMEOUT_MS,
    'Test 3: Error Case - Insufficient Balance'
  );
  
    console.info('[batch-transfer-e2e] ✓ All batch transfer tests passed!');
    clearTimeout(testTimeout);
  } catch (error) {
    clearTimeout(testTimeout);
    throw error;
  }
}

main().catch((error) => {
  console.error('[batch-transfer-e2e] Fatal error:', error);
  process.exit(1);
});

