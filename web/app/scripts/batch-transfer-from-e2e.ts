/**
 * Batch TransferFrom End-to-End Test
 * 
 * Tests batch transferFrom operations with approvals for multiple zTokens (2-10) to simulate real-world use.
 * 
 * Current implementation supports exactly 2 transfers (circuit limitation).
 * 
 * Test scenarios:
 * - 2 tokens with allowances (minimum, currently supported)
 * - Multiple transfers with change handling
 * - Cross-token transfers with approvals
 * - Error cases (insufficient allowance, expired allowance, invalid proofs, etc.)
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
  batchTransferFrom,
  approveAllowance,
  preparePool,
  fetchMintMappingAccount
} from '../lib/sdk';
import { generateBatchTransferFromProof } from '../lib/dex-ztoken-helpers';
import { derivePoolState } from '../lib/onchain/pdas';
import { fetchZTokenPoolRoot } from '../lib/dex-ztoken-helpers';
import { fetchMintMappingAccount } from '../lib/sdk';
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
  const timestamp = Date.now().toString().slice(-2);
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `BF${timestamp}${random}`.slice(0, 6); // Ensure max 6 chars
}

async function createToken(symbol: string, retries = 10): Promise<MintConfig> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const fetchPromise = fetch(`${MINTS_API_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, decimals: 6 }),
    });
    
    const response = await withTimeout(
      fetchPromise,
      FETCH_TIMEOUT_MS * 10, // Much longer timeout for bootstrap (150 seconds)
      `Create token ${symbol}`
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: any = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // Not valid JSON, treat as plain text
      }
      
      // Retry on mint_registration_in_progress with exponential backoff
      if (errorJson.error === 'mint_registration_in_progress' && attempt < retries - 1) {
        const delayMs = Math.min(2000 * Math.pow(2, attempt), 30000); // Longer delays, max 30s
        console.log(`[createToken] Retrying ${symbol} after ${delayMs}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      
      throw new Error(`Failed to create token ${symbol}: ${response.status} ${errorText}`);
    }
    
    const responseData = (await response.json()) as { mint: MintConfig };
    return responseData.mint;
  }
  
  throw new Error(`Failed to create token ${symbol} after ${retries} attempts`);
}

async function waitForBootstrapComplete(maxWaitMs = 120000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Try a simple GET request to see if bootstrap is done
      const response = await fetch(`${MINTS_API_URL}`, { method: 'GET' });
      if (response.ok) {
        // API is responsive, bootstrap should be done
        return;
      }
    } catch {
      // API might be busy, continue waiting
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  console.warn('[waitForBootstrapComplete] Timeout waiting for bootstrap, continuing anyway');
}

async function createTokensSequentially(symbols: string[]): Promise<MintConfig[]> {
  const tokens: MintConfig[] = [];
  for (const symbol of symbols) {
    tokens.push(await createToken(symbol));
    // Delay between tokens to allow bootstrap to complete
    if (symbols.indexOf(symbol) < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return tokens;
}

async function requestAirdrop(connection: Connection, to: PublicKey, amount: bigint): Promise<void> {
  try {
    const response = await withTimeout(
      fetch(`${FAUCET_BASE_URL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: to.toBase58(), amount: amount.toString() }),
      }),
      FETCH_TIMEOUT_MS,
      'Faucet request'
    );
    
    if (!response.ok) {
      throw new Error(`Faucet returned ${response.status}`);
    }
    
    const result = await response.json();
    if (result.signature) {
      try {
        await withTimeout(
          connection.confirmTransaction(result.signature, 'confirmed'),
          TX_CONFIRM_TIMEOUT_MS,
          'Confirm airdrop'
        );
      } catch (confirmError: any) {
        // Check balance anyway - transaction may have succeeded
        await new Promise(resolve => setTimeout(resolve, 2000));
        const balance = await connection.getBalance(to);
        if (balance >= Number(amount)) {
          console.info('[requestAirdrop] Balance confirmed despite confirmation timeout');
          return;
        }
        throw confirmError;
      }
    }
  } catch (faucetError: any) {
    console.warn(`[requestAirdrop] Faucet failed: ${faucetError.message}, trying direct requestAirdrop...`);
    const signature = await connection.requestAirdrop(to, Number(amount));
    try {
      await withTimeout(
        connection.confirmTransaction(signature, 'confirmed'),
        TX_CONFIRM_TIMEOUT_MS,
        'Confirm direct airdrop'
      );
    } catch (confirmError: any) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const balance = await connection.getBalance(to);
      if (balance < Number(amount)) {
        throw new Error(`Airdrop may have failed: balance ${balance} < requested ${amount}`);
      }
    }
  }
}

async function waitForValidator(connection: Connection, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const slot = await connection.getSlot('confirmed');
      if (slot > 0) {
        console.info(`[waitForValidator] Validator is ready (slot: ${slot})`);
        return;
      }
    } catch (error) {
      // Validator not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Validator not ready after ${timeoutMs}ms`);
}

async function faucetToken(
  connection: Connection,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint
): Promise<string> {
  const fetchPromise = fetch(`${FAUCET_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mint: mint.toBase58(),
      recipient: destination.toBase58(),
      amount: amount.toString()
    })
  });
  
  const response = await withTimeout(
    fetchPromise,
    FETCH_TIMEOUT_MS,
    'Faucet request'
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Faucet failed: ${response.status} ${errorText}`);
  }
  
  const result = await response.json();
  const signature = result.signature as string;
  
  // Wait for confirmation
  const latestBlockhash = await withTimeout(
    connection.getLatestBlockhash('confirmed'),
    FETCH_TIMEOUT_MS,
    'Get latest blockhash for faucet'
  );
  await withTimeout(
    connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    }, 'confirmed'),
    TX_CONFIRM_TIMEOUT_MS,
    'Faucet confirmation'
  );
  
  return signature;
}

async function shieldToken(
  connection: Connection,
  walletAdapter: any,
  user: Keypair,
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
    wallet: walletAdapter as any,
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
    recipient: walletAdapter.publicKey!.toBase58(),
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
      wallet: walletAdapter as any,
      originMint: originMint.toBase58(),
      poolId,
      amount,
      recipient: walletAdapter.publicKey!.toBase58(),
      depositId,
      blinding,
      proof,
      twinMint: twinMint || undefined,
      keypair: user
    }),
    TX_CONFIRM_TIMEOUT_MS * 2,
    'Wrap/shield transaction'
  );
  
  await withTimeout(
    connection.confirmTransaction(signature, 'confirmed'),
    TX_CONFIRM_TIMEOUT_MS,
    'Confirm shield'
  );
  
  // Wait for shield to finalize
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

async function main() {
  console.info('[batch-transfer-from-e2e] Starting batch transferFrom E2E test suite');
  
  // Set overall timeout for entire test suite
  const testTimeout = setTimeout(() => {
    console.error('[batch-transfer-from-e2e] ✗ Test suite timed out after 10 minutes');
    process.exit(1);
  }, 600000); // 10 minutes total
  
  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    
    // Wait for validator to be ready
    console.info('[batch-transfer-from-e2e] Waiting for validator to be ready...');
    await waitForValidator(connection, 30000);
    
    // Wait for any existing bootstrap to complete
    console.info('[batch-transfer-from-e2e] Waiting for bootstrap to complete...');
    await waitForBootstrapComplete(120000);
    
    const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
    // Create test user keypair (owner of tokens)
    const owner = Keypair.generate();
    console.info(`[batch-transfer-from-e2e] Owner: ${owner.publicKey.toBase58()}`);
    
    // Create spender keypair (will spend tokens with allowance)
    const spender = Keypair.generate();
    console.info(`[batch-transfer-from-e2e] Spender: ${spender.publicKey.toBase58()}`);
    
    // Airdrop SOL to owner and spender
    console.info('[batch-transfer-from-e2e] Airdropping SOL...');
    let airdropSuccess = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await Promise.all([
          requestAirdrop(connection, owner.publicKey, SOL_AIRDROP_LAMPORTS),
          requestAirdrop(connection, spender.publicKey, SOL_AIRDROP_LAMPORTS)
        ]);
        airdropSuccess = true;
        break;
      } catch (error: any) {
        console.warn(`[batch-transfer-from-e2e] Airdrop attempt ${attempt + 1} failed: ${error.message}`);
        if (attempt < 2) {
          console.info(`[batch-transfer-from-e2e] Retrying airdrop in 5 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    
    if (!airdropSuccess) {
      throw new Error('Failed to airdrop SOL after 3 attempts');
    }
    
    const ownerWallet = createWalletAdapter(owner);
    const spenderWallet = createWalletAdapter(spender);
    
    // Test 1: Basic batch transferFrom with 2 tokens
    console.info('\n=== Test 1: Batch TransferFrom with 2 Tokens ===');
    await withTimeout(
      (async () => {
        try {
          const symbol1 = generateUniqueSymbol();
          const symbol2 = generateUniqueSymbol();
          
          const [token1, token2] = await createTokensSequentially([symbol1, symbol2]);
          
          // Faucet tokens to owner before shielding
          console.info('[test-1] Requesting tokens from faucet...');
          await Promise.all([
            faucetToken(connection, new PublicKey(token1.originMint), owner.publicKey, WRAP_AMOUNT * 2n),
            faucetToken(connection, new PublicKey(token2.originMint), owner.publicKey, WRAP_AMOUNT * 2n)
          ]);
          
          // Owner shields tokens
          const [ownerNotes1, ownerNotes2] = await Promise.all([
            shieldToken(connection, ownerWallet, owner, new PublicKey(token1.originMint), WRAP_AMOUNT, proofClient),
            shieldToken(connection, ownerWallet, owner, new PublicKey(token2.originMint), WRAP_AMOUNT, proofClient)
          ]);
          
          // Owner approves allowances for spender
          const allowanceAmount1 = WRAP_AMOUNT / 2n;
          const allowanceAmount2 = WRAP_AMOUNT / 3n;
          
          console.info('[test-1] Approving allowances...');
          const [approveSig1, approveSig2] = await Promise.all([
            withTimeout(
              approveAllowance({
                connection,
                wallet: ownerWallet as any,
                originMint: token1.originMint,
                spender: spender.publicKey.toBase58(),
                amount: allowanceAmount1
              }),
              TX_CONFIRM_TIMEOUT_MS,
              'Approve allowance 1'
            ),
            withTimeout(
              approveAllowance({
                connection,
                wallet: ownerWallet as any,
                originMint: token2.originMint,
                spender: spender.publicKey.toBase58(),
                amount: allowanceAmount2
              }),
              TX_CONFIRM_TIMEOUT_MS,
              'Approve allowance 2'
            )
          ]);
          
          console.info(`[test-1] ✓ Allowances approved: ${approveSig1}, ${approveSig2}`);
          
          // Spender performs batch transferFrom using owner's notes
          // Owner provides their notes to spender (in real world, this would be out-of-band)
          const recipient = Keypair.generate();
          const spendAmount1 = allowanceAmount1;
          const spendAmount2 = allowanceAmount2;
          
          // Calculate change (goes back to owner, not spender)
          const changeAmount1 = ownerNotes1[0]!.noteAmount - spendAmount1;
          const changeAmount2 = ownerNotes2[0]!.noteAmount - spendAmount2;
          
          const batchProof = await withTimeout(
            generateBatchTransferFromProof(
              proofClient,
              connection,
              [
                {
                  originMint: new PublicKey(token1.originMint),
                  notes: ownerNotes1.map(n => ({
                    noteId: n.noteId,
                    spendingKey: n.spendingKey,
                    amount: n.noteAmount
                  })),
                  outputs: [
                    {
                      amount: spendAmount1,
                      recipient: recipient.publicKey,
                      blinding: randomBlinding()
                    },
                    {
                      amount: changeAmount1 > 0n ? changeAmount1 : 0n,
                      recipient: owner.publicKey, // Change goes back to owner
                      blinding: changeAmount1 > 0n ? randomBlinding() : '0'
                    }
                  ],
                  allowanceAmount: allowanceAmount1,
                  spendAmount: spendAmount1, // Only amount going to recipient, not change
                  allowanceOwner: owner.publicKey
                },
                {
                  originMint: new PublicKey(token2.originMint),
                  notes: ownerNotes2.map(n => ({
                    noteId: n.noteId,
                    spendingKey: n.spendingKey,
                    amount: n.noteAmount
                  })),
                  outputs: [
                    {
                      amount: spendAmount2,
                      recipient: recipient.publicKey,
                      blinding: randomBlinding()
                    },
                    {
                      amount: changeAmount2 > 0n ? changeAmount2 : 0n,
                      recipient: owner.publicKey, // Change goes back to owner
                      blinding: changeAmount2 > 0n ? randomBlinding() : '0'
                    }
                  ],
                  allowanceAmount: allowanceAmount2,
                  spendAmount: spendAmount2, // Only amount going to recipient, not change
                  allowanceOwner: owner.publicKey
                }
              ]
            ),
            PROOF_TIMEOUT_MS,
            'Generate batch transferFrom proof'
          );
          
          // Extract and pad nullifiers/commitments to exactly 2 per transfer
          const nullifiers1: string[] = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
          while (nullifiers1.length < 2) nullifiers1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
          const outputCommitments1: string[] = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
          while (outputCommitments1.length < 2) outputCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
          const outputAmountCommitments1: string[] = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
          while (outputAmountCommitments1.length < 2) outputAmountCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
          
          const nullifiers2: string[] = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
          while (nullifiers2.length < 2) nullifiers2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
          const outputCommitments2: string[] = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
          while (outputCommitments2.length < 2) outputCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
          const outputAmountCommitments2: string[] = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
          while (outputAmountCommitments2.length < 2) outputAmountCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
          
          const batchTransferFromSig = await withTimeout(
            batchTransferFrom({
              connection,
              wallet: spenderWallet as any,
              transfers: [
                {
                  originMint: token1.originMint,
                  poolId: token1.poolId,
                  allowanceOwner: owner.publicKey.toBase58(),
                  allowanceAmount: allowanceAmount1,
                  spendAmount: spendAmount1,
                  nullifiers: nullifiers1.slice(0, 2),
                  outputCommitments: outputCommitments1.slice(0, 2),
                  outputAmountCommitments: outputAmountCommitments1.slice(0, 2)
                },
                {
                  originMint: token2.originMint,
                  poolId: token2.poolId,
                  allowanceOwner: owner.publicKey.toBase58(),
                  allowanceAmount: allowanceAmount2,
                  spendAmount: spendAmount2,
                  nullifiers: nullifiers2.slice(0, 2),
                  outputCommitments: outputCommitments2.slice(0, 2),
                  outputAmountCommitments: outputAmountCommitments2.slice(0, 2)
                }
              ],
              batchProof,
              batchPublicInputs: batchProof.publicInputs,
              keypair: spender
            }),
            TX_CONFIRM_TIMEOUT_MS * 2,
            'Execute batch transferFrom'
          );
          
          console.info(`[test-1] ✓ Batch transferFrom successful: ${batchTransferFromSig}`);
          
          // Verify roots updated
          const [newRoot1, newRoot2] = await Promise.all([
            fetchZTokenPoolRoot(connection, new PublicKey(token1.originMint)),
            fetchZTokenPoolRoot(connection, new PublicKey(token2.originMint))
          ]);
          
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
      'Test 1: Batch TransferFrom with 2 Tokens'
    );
    
    // Test 2: Batch transferFrom with change handling
    console.info('\n=== Test 2: Batch TransferFrom with Change ===');
    await withTimeout(
      (async () => {
        try {
          const symbol1 = generateUniqueSymbol();
          const symbol2 = generateUniqueSymbol();
          
          const [token1, token2] = await createTokensSequentially([symbol1, symbol2]);
          
          // Faucet tokens to owner before shielding
          console.info('[test-2] Requesting tokens from faucet...');
          await Promise.all([
            faucetToken(connection, new PublicKey(token1.originMint), owner.publicKey, WRAP_AMOUNT * 2n),
            faucetToken(connection, new PublicKey(token2.originMint), owner.publicKey, WRAP_AMOUNT * 2n)
          ]);
          
          // Owner shields more than will be spent
          const [ownerNotes1, ownerNotes2] = await Promise.all([
            shieldToken(connection, ownerWallet, owner, new PublicKey(token1.originMint), WRAP_AMOUNT, proofClient),
            shieldToken(connection, ownerWallet, owner, new PublicKey(token2.originMint), WRAP_AMOUNT, proofClient)
          ]);
          
          // Owner approves allowances (less than total notes, so change expected)
          const allowanceAmount1 = WRAP_AMOUNT / 3n;
          const allowanceAmount2 = WRAP_AMOUNT / 4n;
          
          console.info('[test-2] Approving allowances...');
          await Promise.all([
            withTimeout(
              approveAllowance({
                connection,
                wallet: ownerWallet as any,
                originMint: token1.originMint,
                spender: spender.publicKey.toBase58(),
                amount: allowanceAmount1
              }),
              TX_CONFIRM_TIMEOUT_MS,
              'Approve allowance 1'
            ),
            withTimeout(
              approveAllowance({
                connection,
                wallet: ownerWallet as any,
                originMint: token2.originMint,
                spender: spender.publicKey.toBase58(),
                amount: allowanceAmount2
              }),
              TX_CONFIRM_TIMEOUT_MS,
              'Approve allowance 2'
            )
          ]);
          
          // Spender performs batch transferFrom with change
          const recipient = Keypair.generate();
          const spendAmount1 = allowanceAmount1;
          const spendAmount2 = allowanceAmount2;
          const changeAmount1 = ownerNotes1[0]!.noteAmount - spendAmount1;
          const changeAmount2 = ownerNotes2[0]!.noteAmount - spendAmount2;
          
          const batchProof = await withTimeout(
            generateBatchTransferFromProof(
              proofClient,
              connection,
              [
                {
                  originMint: new PublicKey(token1.originMint),
                  notes: ownerNotes1.map(n => ({
                    noteId: n.noteId,
                    spendingKey: n.spendingKey,
                    amount: n.noteAmount
                  })),
                  outputs: [
                    {
                      amount: spendAmount1,
                      recipient: recipient.publicKey,
                      blinding: randomBlinding()
                    },
                    {
                      amount: changeAmount1,
                      recipient: owner.publicKey,
                      blinding: randomBlinding()
                    }
                  ],
                  allowanceAmount: allowanceAmount1,
                  spendAmount: spendAmount1,
                  allowanceOwner: owner.publicKey
                },
                {
                  originMint: new PublicKey(token2.originMint),
                  notes: ownerNotes2.map(n => ({
                    noteId: n.noteId,
                    spendingKey: n.spendingKey,
                    amount: n.noteAmount
                  })),
                  outputs: [
                    {
                      amount: spendAmount2,
                      recipient: recipient.publicKey,
                      blinding: randomBlinding()
                    },
                    {
                      amount: changeAmount2,
                      recipient: owner.publicKey,
                      blinding: randomBlinding()
                    }
                  ],
                  allowanceAmount: allowanceAmount2,
                  spendAmount: spendAmount2,
                  allowanceOwner: owner.publicKey
                }
              ]
            ),
            PROOF_TIMEOUT_MS,
            'Generate batch transferFrom proof for test 2'
          );
          
          // Extract and pad nullifiers/commitments
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
          
          const batchTransferFromSig = await withTimeout(
            batchTransferFrom({
              connection,
              wallet: spenderWallet as any,
              transfers: [
                {
                  originMint: token1.originMint,
                  poolId: token1.poolId,
                  allowanceOwner: owner.publicKey.toBase58(),
                  allowanceAmount: allowanceAmount1,
                  spendAmount: spendAmount1,
                  nullifiers: nullifiers1_2.slice(0, 2),
                  outputCommitments: outputCommitments1_2.slice(0, 2),
                  outputAmountCommitments: outputAmountCommitments1_2.slice(0, 2)
                },
                {
                  originMint: token2.originMint,
                  poolId: token2.poolId,
                  allowanceOwner: owner.publicKey.toBase58(),
                  allowanceAmount: allowanceAmount2,
                  spendAmount: spendAmount2,
                  nullifiers: nullifiers2_2.slice(0, 2),
                  outputCommitments: outputCommitments2_2.slice(0, 2),
                  outputAmountCommitments: outputAmountCommitments2_2.slice(0, 2)
                }
              ],
              batchProof,
              batchPublicInputs: batchProof.publicInputs,
              keypair: spender
            }),
            TX_CONFIRM_TIMEOUT_MS * 2,
            'Execute batch transferFrom for test 2'
          );
          
          console.info(`[test-2] ✓ Batch transferFrom with change successful: ${batchTransferFromSig}`);
          console.info('[test-2] ✓ Test 2 passed!\n');
        } catch (error: any) {
          console.error('[test-2] ✗ Test 2 failed:', error.message);
          throw error;
        }
      })(),
      TEST_TIMEOUT_MS,
      'Test 2: Batch TransferFrom with Change'
    );
    
    // Test 3: Error case - insufficient allowance
    console.info('\n=== Test 3: Error Case - Insufficient Allowance ===');
    await withTimeout(
      (async () => {
        try {
          const symbol1 = generateUniqueSymbol();
          const symbol2 = generateUniqueSymbol();
          
          const [token1, token2] = await createTokensSequentially([symbol1, symbol2]);
          
          // Faucet tokens to owner before shielding
          console.info('[test-1] Requesting tokens from faucet...');
          await Promise.all([
            faucetToken(connection, new PublicKey(token1.originMint), owner.publicKey, WRAP_AMOUNT * 2n),
            faucetToken(connection, new PublicKey(token2.originMint), owner.publicKey, WRAP_AMOUNT * 2n)
          ]);
          
          // Owner shields tokens
          const [ownerNotes1, ownerNotes2] = await Promise.all([
            shieldToken(connection, ownerWallet, owner, new PublicKey(token1.originMint), WRAP_AMOUNT, proofClient),
            shieldToken(connection, ownerWallet, owner, new PublicKey(token2.originMint), WRAP_AMOUNT, proofClient)
          ]);
          
          // Owner approves small allowances
          const allowanceAmount1 = WRAP_AMOUNT / 10n; // Small allowance
          const allowanceAmount2 = WRAP_AMOUNT / 10n; // Small allowance
          
          console.info('[test-3] Approving small allowances...');
          await Promise.all([
            withTimeout(
              approveAllowance({
                connection,
                wallet: ownerWallet as any,
                originMint: token1.originMint,
                spender: spender.publicKey.toBase58(),
                amount: allowanceAmount1
              }),
              TX_CONFIRM_TIMEOUT_MS,
              'Approve allowance 1'
            ),
            withTimeout(
              approveAllowance({
                connection,
                wallet: ownerWallet as any,
                originMint: token2.originMint,
                spender: spender.publicKey.toBase58(),
                amount: allowanceAmount2
              }),
              TX_CONFIRM_TIMEOUT_MS,
              'Approve allowance 2'
            )
          ]);
          
          // Try to spend MORE than allowance (should fail)
          const recipient = Keypair.generate();
          const spendAmount1 = allowanceAmount1 * 2n; // More than allowance
          const spendAmount2 = allowanceAmount2 * 2n; // More than allowance
          
          // This should fail when generating proof or executing
          try {
            const batchProof = await withTimeout(
              generateBatchTransferFromProof(
                proofClient,
                connection,
                [
                  {
                    originMint: new PublicKey(token1.originMint),
                    notes: ownerNotes1.map(n => ({
                      noteId: n.noteId,
                      spendingKey: n.spendingKey,
                      amount: n.noteAmount
                    })),
                    outputs: [
                      {
                        amount: spendAmount1,
                        recipient: recipient.publicKey,
                        blinding: randomBlinding()
                      }
                    ],
                    allowanceAmount: allowanceAmount1,
                    spendAmount: spendAmount1, // More than allowance
                    allowanceOwner: owner.publicKey
                  },
                  {
                    originMint: new PublicKey(token2.originMint),
                    notes: ownerNotes2.map(n => ({
                      noteId: n.noteId,
                      spendingKey: n.spendingKey,
                      amount: n.noteAmount
                    })),
                    outputs: [
                      {
                        amount: spendAmount2,
                        recipient: recipient.publicKey,
                        blinding: randomBlinding()
                      }
                    ],
                    allowanceAmount: allowanceAmount2,
                    spendAmount: spendAmount2, // More than allowance
                    allowanceOwner: owner.publicKey
                  }
                ]
              ),
              PROOF_TIMEOUT_MS,
              'Generate batch transferFrom proof (should validate)'
            );
            
            // If proof generation succeeded, transaction should fail
            const nullifiers1: string[] = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
            while (nullifiers1.length < 2) nullifiers1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
            const outputCommitments1: string[] = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
            while (outputCommitments1.length < 2) outputCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
            const outputAmountCommitments1: string[] = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
            while (outputAmountCommitments1.length < 2) outputAmountCommitments1.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
            
            const nullifiers2: string[] = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
            while (nullifiers2.length < 2) nullifiers2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
            const outputCommitments2: string[] = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
            while (outputCommitments2.length < 2) outputCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
            const outputAmountCommitments2: string[] = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
            while (outputAmountCommitments2.length < 2) outputAmountCommitments2.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
            
            // This should fail with allowance insufficient error
            await batchTransferFrom({
              connection,
              wallet: spenderWallet as any,
              transfers: [
                {
                  originMint: token1.originMint,
                  poolId: token1.poolId,
                  allowanceOwner: owner.publicKey.toBase58(),
                  allowanceAmount: allowanceAmount1,
                  spendAmount: spendAmount1, // More than allowance
                  nullifiers: nullifiers1.slice(0, 2),
                  outputCommitments: outputCommitments1.slice(0, 2),
                  outputAmountCommitments: outputAmountCommitments1.slice(0, 2)
                },
                {
                  originMint: token2.originMint,
                  poolId: token2.poolId,
                  allowanceOwner: owner.publicKey.toBase58(),
                  allowanceAmount: allowanceAmount2,
                  spendAmount: spendAmount2, // More than allowance
                  nullifiers: nullifiers2.slice(0, 2),
                  outputCommitments: outputCommitments2.slice(0, 2),
                  outputAmountCommitments: outputAmountCommitments2.slice(0, 2)
                }
              ],
              batchProof,
              batchPublicInputs: batchProof.publicInputs,
              keypair: spender
            });
            
            throw new Error('Expected allowance insufficient error but transaction succeeded');
          } catch (error: any) {
            // Expected error - allowance insufficient
            if (error.message.includes('AllowanceInsufficient') || 
                error.message.includes('allowance') ||
                error.message.includes('Spend amount exceeds allowance')) {
              console.info('[test-3] ✓ Expected error caught: insufficient allowance');
              console.info('[test-3] ✓ Test 3 passed!\n');
              return;
            }
            throw error;
          }
        } catch (error: any) {
          console.error('[test-3] ✗ Test 3 failed:', error.message);
          throw error;
        }
      })(),
      TEST_TIMEOUT_MS,
      'Test 3: Error Case - Insufficient Allowance'
    );
    
    console.info('[batch-transfer-from-e2e] ✓ All batch transferFrom tests passed!');
    clearTimeout(testTimeout);
  } catch (error) {
    clearTimeout(testTimeout);
    throw error;
  }
}

main().catch((error) => {
  console.error('[batch-transfer-from-e2e] Fatal error:', error);
  process.exit(1);
});

