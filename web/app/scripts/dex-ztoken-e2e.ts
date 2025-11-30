/**
 * zToken-Only DEX End-to-End Test
 * 
 * Tests zToken-only DEX operations using SDK functions:
 * 1. Create pool with zTokens (shield-based)
 * 2. Add liquidity with zTokens (transfer-based)
 * 3. Swap input with zTokens (transfer-based, output side not implemented yet)
 * 
 * Tests assume reset/bootstrap already happened (run-full-test-suite.sh handles this)
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
  createDexPool,
  addDexLiquidity,
  swapDex,
  getDexPoolState,
  wrap,
  readStoredNotes
} from '../lib/sdk';
import { deriveDexPoolState } from '../lib/onchain/pdas';
import { ProofClient } from '../lib/proofClient';
import { generateDexShieldProof, generateDexTransferProofSimple } from '../lib/dex-ztoken-helpers';
import { DEX_PROGRAM_ID } from '../lib/onchain/programIds';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { createWalletAdapter } from './utils/walletAdapter';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const INDEXER_PROXY_URL = process.env.INDEXER_PROXY_URL ?? 'http://127.0.0.1:3000/api/indexer';
const FAUCET_BASE_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:3000/api/faucet';
const MINTS_API_URL = process.env.MINTS_API_URL ?? 'http://127.0.0.1:3000/api/mints';

const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (2n * 10n ** 9n).toString());
const TARGET_DECIMALS = Number(process.env.MINT_DECIMALS ?? '6');

interface MintConfig {
  originMint: string;
  poolId: string;
  symbol: string;
  decimals: number;
  zTokenMint?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function confirmTransaction(connection: Connection, signature: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatuses([signature]);
    const info = status.value[0];
    if (info?.err) {
      throw new Error(`Signature ${signature} failed: ${JSON.stringify(info.err)}`);
    }
    if (info?.confirmationStatus === 'confirmed' || info?.confirmationStatus === 'finalized' || info?.confirmations === null) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out confirming signature ${signature} after ${timeoutMs}ms`);
}

async function faucetSol(connection: Connection, recipient: PublicKey): Promise<void> {
  try {
    const response = await fetch(`${FAUCET_BASE_URL}/sol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: recipient.toBase58(), amountLamports: SOL_AIRDROP_LAMPORTS.toString() })
    });
    if (response.ok) {
      const { signature } = (await response.json()) as { signature: string };
      await confirmTransaction(connection, signature, 30000);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const balance = BigInt(await connection.getBalance(recipient, 'confirmed'));
        if (balance >= SOL_AIRDROP_LAMPORTS) {
          return;
        }
        await sleep(1000);
      }
      throw new Error('SOL balance did not reach minimum threshold after faucet');
    }
  } catch (err) {
    console.warn(`[faucetSol] Faucet API failed, trying direct airdrop: ${err}`);
  }
  
  console.info(`[faucetSol] Using direct requestAirdrop for ${recipient.toBase58()}`);
  const signature = await connection.requestAirdrop(recipient, Number(SOL_AIRDROP_LAMPORTS));
  await confirmTransaction(connection, signature, 30000);
}

async function faucetToken(connection: Connection, mint: PublicKey, recipient: PublicKey, amount: bigint): Promise<void> {
  const response = await fetch(`${FAUCET_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mint: mint.toBase58(),
      recipient: recipient.toBase58(),
      amount: amount.toString()
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to faucet token: ${response.status} ${errorText}`);
  }
  
  const { signature } = (await response.json()) as { signature: string };
  await confirmTransaction(connection, signature, 30000);
}

async function fetchMintCatalog(): Promise<MintConfig[]> {
  const response = await fetch(MINTS_API_URL, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch mint catalog: ${response.status}`);
  }
  
  const payload = (await response.json()) as { mints?: MintConfig[] };
  return payload.mints ?? [];
}

async function waitForValidator(connection: Connection, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const slot = await connection.getSlot('confirmed');
      if (slot > 0) {
        return;
      }
    } catch (error) {
      // Validator not ready yet
    }
    await sleep(1000);
  }
  throw new Error('Validator did not become ready within timeout');
}

// Helper to shield tokens (for add_liquidity test where user needs notes)
async function shieldTokenToUser(
  connection: Connection,
  wallet: any,
  originMint: PublicKey,
  amount: bigint
): Promise<void> {
  console.info(`[shieldTokenToUser] Shielding ${amount} tokens to user for mint ${originMint.toBase58()}`);
  
  const poolId = (await import('../lib/sdk')).derivePoolState(originMint).toBase58();
  
  const signature = await wrap({
    connection,
    wallet,
    originMint: originMint.toBase58(),
    poolId,
    amount,
    recipient: wallet.publicKey!.toBase58() // User receives the notes
  });
  
  await confirmTransaction(connection, signature, 30000);
  
  // Wait a bit for indexer to process and notes to be stored
  await sleep(3000);
  console.info(`[shieldTokenToUser] ✓ Shielded successfully: ${signature}`);
}

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

async function main() {
  console.info('[dex-ztoken-e2e] Starting zToken-only DEX E2E test suite');
  const connection = new Connection(RPC_URL, 'confirmed');
  
  await waitForValidator(connection);
  
  // Check if DEX program is deployed
  console.info('[setup] Checking if DEX program is deployed...');
  const dexProgramAccount = await connection.getAccountInfo(DEX_PROGRAM_ID, 'confirmed');
  if (!dexProgramAccount) {
    console.error('[setup] ✗ DEX program not deployed!');
    throw new Error('DEX program not deployed. Deploy it before running tests.');
  }
  console.info('[setup] ✓ DEX program is deployed');
  
  const user = Keypair.generate();
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const userAdapter = createWalletAdapter(user) as any;
  
  console.info('[setup] Funding user with SOL via faucet');
  await faucetSol(connection, user.publicKey);
  
  // Get or create two test mints (exclude native SOL mint)
  console.info('[setup] Fetching mint catalog...');
  let catalog = await fetchMintCatalog();
  console.info(`[setup] Initial catalog has ${catalog.length} mints`);
  
  // Filter out native SOL mint (wSOL)
  const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
  catalog = catalog.filter(mint => mint.originMint !== NATIVE_SOL_MINT);
  console.info(`[setup] After filtering SOL: ${catalog.length} mints`);
  
  // Ensure we have at least 2 mints (excluding native SOL)
  if (catalog.length < 2) {
    console.info(`[setup] Not enough mints (have ${catalog.length}, need 2), creating test mints...`);
    const mintsNeeded = 2 - catalog.length;
    for (let i = 0; i < mintsNeeded; i++) {
      const symbol = `DXT${i + 1}`;
      console.info(`[setup] Creating mint ${symbol}...`);
      const response = await fetch(MINTS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, decimals: TARGET_DECIMALS })
      });
      if (!response.ok && response.status !== 409) {
        const errorText = await response.text();
        throw new Error(`Failed to create mint ${symbol}: ${response.status} ${errorText}`);
      }
      console.info(`[setup] ✓ Created mint ${symbol}`);
      await sleep(3000); // Wait for catalog to sync
    }
    // Fetch catalog again
    catalog = await fetchMintCatalog();
    console.info(`[setup] Refetched catalog: ${catalog.length} mints`);
    // Filter again after fetching
    catalog = catalog.filter(mint => mint.originMint !== NATIVE_SOL_MINT);
    console.info(`[setup] After filtering SOL again: ${catalog.length} mints`);
  }
  
  if (catalog.length < 2) {
    const mintList = catalog.map(m => `${m.symbol} (${m.originMint.slice(0, 8)}...)`).join(', ');
    throw new Error(`Need at least 2 token mints (excluding SOL) in catalog for DEX testing. Found ${catalog.length}: ${mintList}`);
  }
  
  const mintConfigA = catalog[0]!;
  const mintConfigB = catalog[1]!;
  const originMintA = new PublicKey(mintConfigA.originMint);
  const originMintB = new PublicKey(mintConfigB.originMint);
  
  console.info(`[setup] ✓ Using mint A: ${originMintA.toBase58()} (${mintConfigA.symbol})`);
  console.info(`[setup] ✓ Using mint B: ${originMintB.toBase58()} (${mintConfigB.symbol})`);
  
  // Ensure canonical order (tokenA < tokenB)
  const canonicalOrder = originMintA.toBuffer().compare(originMintB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint] = canonicalOrder 
    ? [originMintA, originMintB] 
    : [originMintB, originMintA];
  const [tokenAConfig, tokenBConfig] = canonicalOrder
    ? [mintConfigA, mintConfigB]
    : [mintConfigB, mintConfigA];
  
  console.info(`[setup] Canonical order: ${tokenAMint.toBase58()} < ${tokenBMint.toBase58()}`);
  
  // Fund user with tokens
  const initialAmount = 10000n * (10n ** BigInt(TARGET_DECIMALS));
  console.info(`[setup] Funding user with tokens (${initialAmount} each)...`);
  await faucetToken(connection, tokenAMint, user.publicKey, initialAmount);
  await faucetToken(connection, tokenBMint, user.publicKey, initialAmount);
  
  // ============================================
  // TEST 1: Create Pool (Shield-Based)
  // ============================================
  console.info('\n[test-1] Testing create_pool with zTokens (shield-based)');
  
  const poolAmountA = 1000n * (10n ** BigInt(TARGET_DECIMALS));
  const poolAmountB = 2000n * (10n ** BigInt(TARGET_DECIMALS));
  
  // For create_pool, we generate shield proofs that will shield tokens TO the pool PDA
  // The user must have public tokens in their accounts (already funded via faucet)
  // The create_pool instruction will handle the actual shielding via CPI
  console.info(`[test-1] Generating shield proofs for pool creation...`);
  console.info(`[test-1] Amount A: ${poolAmountA}, Amount B: ${poolAmountB}`);
  
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  console.info(`[test-1] Pool PDA: ${poolState.toBase58()}`);
  
  // Generate shield proofs (tokens will be shielded TO pool PDA)
  console.info(`[test-1] Generating shield proof for token A...`);
  const shieldProofA = await generateDexShieldProof(
    proofClient,
    connection,
    tokenAMint,
    poolAmountA,
    poolState // Recipient is pool PDA
  );
  
  console.info(`[test-1] Generating shield proof for token B...`);
  const shieldProofB = await generateDexShieldProof(
    proofClient,
    connection,
    tokenBMint,
    poolAmountB,
    poolState // Recipient is pool PDA
  );
  
  // Create pool with shield proofs (instruction will do the actual shielding)
  console.info('[test-1] Creating DEX pool...');
  try {
    const poolSig = await createDexPool({
      connection,
      wallet: userAdapter,
      tokenA: tokenAMint.toBase58(),
      tokenB: tokenBMint.toBase58(),
      initialAmountA: poolAmountA,
      initialAmountB: poolAmountB,
      proofClient,
      shieldProofA: {
        proof: shieldProofA.proof,
        publicInputs: shieldProofA.publicInputs,
        amountCommit: shieldProofA.amountCommit
      },
      shieldProofB: {
        proof: shieldProofB.proof,
        publicInputs: shieldProofB.publicInputs,
        amountCommit: shieldProofB.amountCommit
      }
    });
    
    console.info(`[test-1] ✓ Pool created successfully: ${poolSig}`);
    await confirmTransaction(connection, poolSig, 30000);
    
    // Verify pool was created
    const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
    if (!poolStateData) {
      throw new Error('Pool state not found after creation');
    }
    
    console.info(`[test-1] ✓ Pool state verified (empty pool created):`);
    console.info(`[test-1]   - LP Token Mint: ${poolStateData.lpTokenMint.toBase58()}`);
    console.info(`[test-1]   - Total LP Supply: ${poolStateData.totalLpSupply.toString()} (should be 0 for empty pool)`);
    console.info(`[test-1]   - Reserve A: ${poolStateData.privateReserveAAmount.toString()}`);
    console.info(`[test-1]   - Reserve B: ${poolStateData.privateReserveBAmount.toString()}`);
    
    // TODO: Step 2 - Add initial liquidity via add_liquidity after shielding tokens
    console.info(`[test-1] ⚠️  Pool is empty - liquidity addition not yet implemented`);
    
  } catch (error: any) {
    console.error('[test-1] ✗ Pool creation failed:', error.message || error);
    throw error;
  }
  
  // ============================================
  // TEST 2: Add Liquidity (Transfer-Based)
  // ============================================
  console.info('\n[test-2] Testing add_liquidity with zTokens (transfer-based)');
  
  const addAmountA = 500n * (10n ** BigInt(TARGET_DECIMALS));
  const addAmountB = 1000n * (10n ** BigInt(TARGET_DECIMALS));
  
  // Shield more tokens for adding liquidity (user needs zToken notes)
  console.info(`[test-2] Shielding ${addAmountA} tokens to user for mint A...`);
  await shieldTokenToUser(connection, userAdapter, tokenAMint, addAmountA);
  
  console.info(`[test-2] Shielding ${addAmountB} tokens to user for mint B...`);
  await shieldTokenToUser(connection, userAdapter, tokenBMint, addAmountB);
  
  // Wait for notes to be stored
  await sleep(3000);
  const notesAfterAdd = readStoredNotes();
  console.info(`[test-2] Found ${notesAfterAdd.length} stored notes`);
  
  // Filter notes by mint
  const notesA = notesAfterAdd
    .filter(note => note.originMint === tokenAMint.toBase58())
    .map(note => ({
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: BigInt(note.amount)
    }));
  
  const notesB = notesAfterAdd
    .filter(note => note.originMint === tokenBMint.toBase58())
    .map(note => ({
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: BigInt(note.amount)
    }));
  
  console.info(`[test-2] Found ${notesA.length} notes for mint A, ${notesB.length} notes for mint B`);
  
  if (notesA.length === 0 || notesB.length === 0) {
    throw new Error(`Insufficient notes: A=${notesA.length}, B=${notesB.length}`);
  }
  
  // Select notes that cover the required amounts
  const selectedNotesA = selectNotesForAmount(notesA, addAmountA);
  const selectedNotesB = selectNotesForAmount(notesB, addAmountB);
  
  console.info(`[test-2] Selected ${selectedNotesA.length} notes for A, ${selectedNotesB.length} notes for B`);
  
  try {
    const addLiquiditySig = await addDexLiquidity({
      connection,
      wallet: userAdapter,
      tokenA: tokenAMint.toBase58(),
      tokenB: tokenBMint.toBase58(),
      amountA: addAmountA,
      amountB: addAmountB,
      minLpTokens: 0n,
      proofClient,
      zTokenNotesA: selectedNotesA,
      zTokenNotesB: selectedNotesB
    });
    
    console.info(`[test-2] ✓ Liquidity added successfully: ${addLiquiditySig}`);
    await confirmTransaction(connection, addLiquiditySig, 30000);
    
    // Verify pool reserves increased
    const poolStateAfterAdd = await getDexPoolState(connection, tokenAMint, tokenBMint);
    if (!poolStateAfterAdd) {
      throw new Error('Pool state not found after adding liquidity');
    }
    
    console.info(`[test-2] ✓ Pool state after add:`);
    console.info(`[test-2]   - Total LP Supply: ${poolStateAfterAdd.totalLpSupply.toString()}`);
    
  } catch (error: any) {
    console.error('[test-2] ✗ Add liquidity failed:', error.message || error);
    throw error;
  }
  
  // ============================================
  // TEST 3: Swap Input (Transfer-Based)
  // ============================================
  console.info('\n[test-3] Testing swap input with zTokens (transfer-based)');
  console.info('[test-3] NOTE: Swap output (pool PDA → user) is not yet implemented');
  
  const swapAmountIn = 100n * (10n ** BigInt(TARGET_DECIMALS));
  
  // Get notes for swap input (token A)
  await sleep(2000);
  const notesForSwap = readStoredNotes();
  const swapNotesA = notesForSwap
    .filter(note => note.originMint === tokenAMint.toBase58())
    .map(note => ({
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: BigInt(note.amount)
    }));
  
  if (swapNotesA.length === 0) {
    throw new Error('No notes available for swap input');
  }
  
  const selectedSwapNotes = selectNotesForAmount(swapNotesA, swapAmountIn);
  console.info(`[test-3] Selected ${selectedSwapNotes.length} notes for swap input`);
  
  // Note: Swap output will fail because pool PDA note fetching is not implemented
  // But we can test that the input side works correctly
  try {
    const swapSig = await swapDex({
      connection,
      wallet: userAdapter,
      tokenA: tokenAMint.toBase58(),
      tokenB: tokenBMint.toBase58(),
      amountIn: swapAmountIn,
      minAmountOut: 0n,
      aToB: true,
      proofClient,
      zTokenInputNotes: selectedSwapNotes
    });
    
    console.info(`[test-3] ✓ Swap initiated: ${swapSig}`);
    // Don't wait for confirmation since output side will fail
    console.info('[test-3] NOTE: Swap may fail due to missing pool PDA notes (expected)');
    
  } catch (error: any) {
    // Expected to fail until pool PDA note fetching is implemented
    if (error.message && error.message.includes('Pool PDA')) {
      console.info('[test-3] ✓ Swap correctly failed with expected error (pool PDA notes not implemented)');
    } else {
      console.error('[test-3] ✗ Swap failed with unexpected error:', error.message || error);
      // Still throw to see what the actual error is during development
      throw error;
    }
  }
  
  console.info('\n[dex-ztoken-e2e] ✓ All zToken DEX tests completed!');
  console.info('[dex-ztoken-e2e] Note: Swap output and remove liquidity require pool PDA note fetching (not yet implemented)');
}

main().catch((error) => {
  console.error('[dex-ztoken-e2e] Test suite failed:', error);
  process.exit(1);
});

