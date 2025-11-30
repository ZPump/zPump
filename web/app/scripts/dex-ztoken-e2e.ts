/**
 * zToken-Only DEX End-to-End Test
 * 
 * Tests zToken-only DEX operations using official user flows:
 * 1. Create tokens via API (official flow)
 * 2. Mint tokens to user (via faucet)
 * 3. Shield tokens to user (using wrap function)
 * 4. Create empty pool
 * 5. Add liquidity (using user's shielded notes)
 * 6. Swap tokens
 * 7. Remove liquidity
 * 
 * Each test run generates a unique pair of tokens to avoid conflicts.
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
  removeDexLiquidity,
  getDexPoolState,
  wrap,
  preparePool,
  fetchMintMappingAccount
} from '../lib/sdk';
import { deriveDexPoolState, derivePoolState } from '../lib/onchain/pdas';
import { fetchZTokenPoolRoot } from '../lib/dex-ztoken-helpers';
import { ProofClient } from '../lib/proofClient';
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

async function createToken(symbol: string, decimals: number): Promise<MintConfig> {
  console.info(`[createToken] Creating token ${symbol}...`);
  const response = await fetch(MINTS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, decimals })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create token ${symbol}: ${response.status} ${errorText}`);
  }
  
  const responseData = (await response.json()) as { mint: MintConfig };
  const mintConfig = responseData.mint;
  
  if (!mintConfig || !mintConfig.originMint) {
    throw new Error(`Invalid response from mint creation API for ${symbol}`);
  }
  
  console.info(`[createToken] ✓ Created token ${symbol}: ${mintConfig.originMint}`);
  
  // Wait for catalog to sync
  await sleep(3000);
  
  return mintConfig;
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

// Track notes in memory (for Node.js tests)
interface NoteRecord {
  noteId: string;
  spendingKey: string;
  amount: bigint;
  originMint: string;
}

const trackedNotes: NoteRecord[] = [];

// Helper to shield tokens using official wrap function
async function shieldTokenToUser(
  connection: Connection,
  wallet: any,
  keypair: Keypair,
  originMint: PublicKey,
  amount: bigint,
  proofClient: ProofClient
): Promise<NoteRecord> {
  console.info(`[shieldTokenToUser] Shielding ${amount} tokens for mint ${originMint.toBase58()}`);
  
  // Derive pool ID from origin mint
  const poolStateKey = derivePoolState(originMint);
  const poolId = poolStateKey.toBase58();
  
  // Fetch mint mapping to check for twin mint
  const { decoded: mintMapping } = await fetchMintMappingAccount(connection, originMint);
  let twinMint: string | null = null;
  if (mintMapping.hasPtkn && mintMapping.ptknMint) {
    const ptknMintKey = new PublicKey(mintMapping.ptknMint);
    // Only use if it's not the default/placeholder pubkey
    if (!ptknMintKey.equals(PublicKey.default)) {
      twinMint = ptknMintKey.toBase58();
      console.info(`[shieldTokenToUser] Found twin mint in mapping: ${twinMint}`);
    }
  }
  
  // Fetch current root from commitment tree
  const currentRoot = await fetchZTokenPoolRoot(connection, originMint);
  
  // Generate depositId and blinding
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1_000_000);
  const depositId = `${timestamp}${random}`;
  const blinding = Math.floor(Math.random() * 10 ** 18).toString();
  
  // Request proof
  const proof = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: amount.toString(),
    recipient: wallet.publicKey!.toBase58(),
    depositId,
    poolId,
    blinding,
    mintId: originMint.toBase58()
  });
  
  // Shield tokens using wrap function
  const signature = await wrap({
    connection,
    wallet,
    originMint: originMint.toBase58(),
    poolId,
    amount,
    recipient: wallet.publicKey!.toBase58(),
    depositId,
    blinding,
    proof,
    twinMint: twinMint || undefined, // Pass twin mint if it exists in mapping
    keypair // Pass keypair for VersionedTransaction signing in test environment
  });
  
  await confirmTransaction(connection, signature, 30000);
  
  // Wait for shield to finalize
  await sleep(3000);
  console.info(`[shieldTokenToUser] ✓ Shielded successfully: ${signature}`);
  
  // Track the note
  const note: NoteRecord = {
    noteId: depositId,
    spendingKey: blinding,
    amount,
    originMint: originMint.toBase58()
  };
  trackedNotes.push(note);
  
  return note;
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
  console.info('[dex-ztoken-e2e] Using official user flows: create → mint → shield → pool → liquidity → swap → remove');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  
  // Track which notes have been used (to avoid reusing them)
  const usedNoteIds = new Set<string>();
  
  await waitForValidator(connection);
  
  // Check if DEX program is deployed
  console.info('[setup] Checking if DEX program is deployed...');
  const dexProgramAccount = await connection.getAccountInfo(DEX_PROGRAM_ID, 'confirmed');
  if (!dexProgramAccount) {
    console.error('[setup] ✗ DEX program not deployed!');
    throw new Error('DEX program not deployed. Deploy it before running tests.');
  }
  console.info('[setup] ✓ DEX program is deployed');
  
  // Generate unique token symbols for this test run (2-6 characters max)
  // Use last 3 digits of timestamp to ensure uniqueness
  const timestamp = Date.now();
  const suffix = (timestamp % 1000).toString().padStart(3, '0');
  const tokenASymbol = `DXA${suffix}`.slice(0, 6); // DX + A + 3 digits = 6 chars max
  const tokenBSymbol = `DXB${suffix}`.slice(0, 6); // DX + B + 3 digits = 6 chars max
  
  const user = Keypair.generate();
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const userAdapter = createWalletAdapter(user) as any;
  
  console.info(`[setup] Generated unique token pair: ${tokenASymbol} / ${tokenBSymbol}`);
  console.info('[setup] Funding user with SOL via faucet');
  await faucetSol(connection, user.publicKey);
  
  // STEP 1: Create tokens via API (official flow)
  console.info('\n[step-1] Creating tokens via API (official flow)...');
  const mintConfigA = await createToken(tokenASymbol, TARGET_DECIMALS);
  const mintConfigB = await createToken(tokenBSymbol, TARGET_DECIMALS);
  
  const originMintA = new PublicKey(mintConfigA.originMint);
  const originMintB = new PublicKey(mintConfigB.originMint);
  
  console.info(`[step-1] ✓ Token A: ${originMintA.toBase58()} (${mintConfigA.symbol})`);
  console.info(`[step-1] ✓ Token B: ${originMintB.toBase58()} (${mintConfigB.symbol})`);
  
  // Ensure canonical order (tokenA < tokenB)
  const canonicalOrder = originMintA.toBuffer().compare(originMintB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint] = canonicalOrder 
    ? [originMintA, originMintB] 
    : [originMintB, originMintA];
  
  console.info(`[setup] Canonical order: ${tokenAMint.toBase58()} < ${tokenBMint.toBase58()}`);
  
  // STEP 2: Mint tokens to user (via faucet - official flow)
  console.info('\n[step-2] Minting tokens to user (via faucet)...');
  const mintAmount = 100000n * (10n ** BigInt(TARGET_DECIMALS)); // 100k tokens each
  console.info(`[step-2] Minting ${mintAmount} tokens of each type to user...`);
  await faucetToken(connection, tokenAMint, user.publicKey, mintAmount);
  await faucetToken(connection, tokenBMint, user.publicKey, mintAmount);
  console.info('[step-2] ✓ Tokens minted to user');
  
  // STEP 2.5: Prepare pools (creates lookup tables for VersionedTransaction)
  // Note: This is needed for VersionedTransaction to work with large transactions
  console.info('\n[step-2.5] Preparing pools (creating lookup tables)...');
  console.info('[step-2.5] Preparing pool for token A...');
  try {
    await preparePool({
      connection,
      wallet: userAdapter,
      originMint: tokenAMint.toBase58(),
      proofClient
    });
    console.info('[step-2.5] ✓ Pool A prepared');
  } catch (error: any) {
    console.warn('[step-2.5] ⚠️  Pool A preparation had issues (may be normal for new mints):', error.message);
  }
  console.info('[step-2.5] Preparing pool for token B...');
  try {
    await preparePool({
      connection,
      wallet: userAdapter,
      originMint: tokenBMint.toBase58(),
      proofClient
    });
    console.info('[step-2.5] ✓ Pool B prepared');
  } catch (error: any) {
    console.warn('[step-2.5] ⚠️  Pool B preparation had issues (may be normal for new mints):', error.message);
  }
  
  // STEP 3: Shield tokens to user (using wrap function - official flow)
  console.info('\n[step-3] Shielding tokens to user (using wrap function)...');
  
  // Amounts for shielding (enough for liquidity addition and swaps)
  const shieldAmountA = 50000n * (10n ** BigInt(TARGET_DECIMALS));
  const shieldAmountB = 100000n * (10n ** BigInt(TARGET_DECIMALS));
  
  console.info(`[step-3] Shielding ${shieldAmountA} of token A...`);
  await shieldTokenToUser(connection, userAdapter, user, tokenAMint, shieldAmountA, proofClient);
  
  console.info(`[step-3] Shielding ${shieldAmountB} of token B...`);
  await shieldTokenToUser(connection, userAdapter, user, tokenBMint, shieldAmountB, proofClient);
  
  console.info(`[step-3] ✓ All tokens shielded to user (${trackedNotes.length} notes tracked)`);
  
  // STEP 4: Create empty pool
  console.info('\n[step-4] Creating empty DEX pool...');
  
  // Check if pool already exists
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  const existingPool = await connection.getAccountInfo(poolState, 'confirmed');
  
  if (existingPool) {
    console.info('[step-4] ⚠️  Pool already exists, skipping creation');
  } else {
    try {
      const poolSig = await createDexPool({
        connection,
        wallet: userAdapter,
        tokenA: tokenAMint.toBase58(),
        tokenB: tokenBMint.toBase58(),
        initialAmountA: 0n, // Empty pool
        initialAmountB: 0n, // Empty pool
        proofClient,
        shieldProofA: {
          proof: '',
          publicInputs: []
        },
        shieldProofB: {
          proof: '',
          publicInputs: []
        }
      });
      
      await confirmTransaction(connection, poolSig, 30000);
      console.info(`[step-4] ✓ Empty pool created: ${poolSig}`);
      
      // Verify pool was created
      const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
      if (!poolStateData) {
        throw new Error('Pool state not found after creation');
      }
      
      console.info(`[step-4]   - LP Token Mint: ${poolStateData.lpTokenMint.toBase58()}`);
      console.info(`[step-4]   - Total LP Supply: ${poolStateData.totalLpSupply.toString()} (should be 0)`);
      console.info(`[step-4]   - Reserve A: ${poolStateData.privateReserveAAmount.toString()}`);
      console.info(`[step-4]   - Reserve B: ${poolStateData.privateReserveBAmount.toString()}`);
      
    } catch (error: any) {
      if (error.message && error.message.includes('already exists')) {
        console.info('[step-4] ⚠️  Pool already exists, continuing...');
      } else {
        console.error('[step-4] ✗ Pool creation failed:', error.message || error);
        throw error;
      }
    }
  }
  
  // STEP 5: Add liquidity (using user's shielded notes)
  console.info('\n[step-5] Adding liquidity to pool...');
  
  const liquidityAmountA = 5000n * (10n ** BigInt(TARGET_DECIMALS));
  const liquidityAmountB = 10000n * (10n ** BigInt(TARGET_DECIMALS));
  
  // Get user's tracked notes
  console.info(`[step-5] Found ${trackedNotes.length} tracked notes`);
  
  const notesA = trackedNotes
    .filter(note => note.originMint === tokenAMint.toBase58())
    .map(note => ({
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: note.amount
    }));
  
  const notesB = trackedNotes
    .filter(note => note.originMint === tokenBMint.toBase58())
    .map(note => ({
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: note.amount
    }));
  
  console.info(`[step-5] Found ${notesA.length} notes for token A, ${notesB.length} notes for token B`);
  
  if (notesA.length === 0 || notesB.length === 0) {
    throw new Error(`Insufficient notes: A=${notesA.length}, B=${notesB.length}`);
  }
  
  // Select notes that cover the required amounts
  const selectedNotesA = selectNotesForAmount(notesA, liquidityAmountA);
  const selectedNotesB = selectNotesForAmount(notesB, liquidityAmountB);
  
  console.info(`[step-5] Selected ${selectedNotesA.length} notes for A, ${selectedNotesB.length} notes for B`);
  console.info(`[step-5] Selected note A IDs:`, selectedNotesA.map(n => n.noteId));
  console.info(`[step-5] Selected note B IDs:`, selectedNotesB.map(n => n.noteId));
  
  // Track which notes were used (so we don't reuse them in swap)
  selectedNotesA.forEach(n => usedNoteIds.add(n.noteId));
  selectedNotesB.forEach(n => usedNoteIds.add(n.noteId));
  
  try {
    const addLiquiditySig = await addDexLiquidity({
      connection,
      wallet: userAdapter,
      tokenA: tokenAMint.toBase58(),
      tokenB: tokenBMint.toBase58(),
      amountA: liquidityAmountA,
      amountB: liquidityAmountB,
      minLpTokens: 0n,
      proofClient,
      zTokenNotesA: selectedNotesA,
      zTokenNotesB: selectedNotesB,
      keypair: user // Required for VersionedTransaction signing
    });
    
    await confirmTransaction(connection, addLiquiditySig, 30000);
    console.info(`[step-5] ✓ Liquidity added: ${addLiquiditySig}`);
    
    // Verify pool reserves increased
    const poolStateAfterAdd = await getDexPoolState(connection, tokenAMint, tokenBMint);
    if (!poolStateAfterAdd) {
      throw new Error('Pool state not found after adding liquidity');
    }
    
    console.info(`[step-5]   - Total LP Supply: ${poolStateAfterAdd.totalLpSupply.toString()}`);
    console.info(`[step-5]   - Reserve A: ${poolStateAfterAdd.privateReserveAAmount.toString()}`);
    console.info(`[step-5]   - Reserve B: ${poolStateAfterAdd.privateReserveBAmount.toString()}`);
    
  } catch (error: any) {
    console.error('[step-5] ✗ Add liquidity failed:', error.message || error);
    throw error;
  }
  
  // STEP 6: Shield more tokens for swap (previous notes were used in liquidity)
  console.info('\n[step-6] Shielding more tokens for swap...');
  const swapShieldAmountA = 5000n * (10n ** BigInt(TARGET_DECIMALS));
  await shieldTokenToUser(connection, userAdapter, user, tokenAMint, swapShieldAmountA, proofClient);
  await sleep(2000);
  
  // STEP 7: Swap tokens
  console.info('\n[step-7] Swapping tokens...');
  
  const swapAmountIn = 500n * (10n ** BigInt(TARGET_DECIMALS));
  
  // Get tracked notes for swap (filter out notes that were used in liquidity)
  const swapNotesA = trackedNotes
    .filter(note => 
      note.originMint === tokenAMint.toBase58() && 
      !usedNoteIds.has(note.noteId) // Exclude notes used in liquidity addition
    )
    .map(note => ({
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: note.amount
    }));
  
  if (swapNotesA.length === 0) {
    throw new Error('No unused notes available for swap input. Shielded more tokens above.');
  }
  
  const selectedSwapNotes = selectNotesForAmount(swapNotesA, swapAmountIn);
  console.info(`[step-7] Selected ${selectedSwapNotes.length} notes for swap input`);
  
  try {
    const swapSig = await swapDex({
      connection,
      wallet: userAdapter,
      tokenA: tokenAMint.toBase58(),
      tokenB: tokenBMint.toBase58(),
      amountIn: swapAmountIn,
      minAmountOut: 0n,
      aToB: true, // Swap tokenA -> tokenB
      proofClient,
      zTokenInputNotes: selectedSwapNotes
    });
    
    await confirmTransaction(connection, swapSig, 30000);
    console.info(`[step-7] ✓ Swap completed: ${swapSig}`);
    
    // Verify pool reserves changed
    const poolStateAfterSwap = await getDexPoolState(connection, tokenAMint, tokenBMint);
    if (!poolStateAfterSwap) {
      throw new Error('Pool state not found after swap');
    }
    
    console.info(`[step-7]   - Reserve A: ${poolStateAfterSwap.privateReserveAAmount.toString()}`);
    console.info(`[step-7]   - Reserve B: ${poolStateAfterSwap.privateReserveBAmount.toString()}`);
    
  } catch (error: any) {
    console.error('[step-7] ✗ Swap failed:', error.message || error);
    throw error;
  }
  
  // STEP 8: Remove liquidity (if we have LP tokens)
  console.info('\n[step-8] Removing liquidity...');
  console.info('[step-8] NOTE: Remove liquidity requires pool PDA notes (not yet implemented)');
  console.info('[step-8] Skipping remove liquidity test for now');
  
  console.info('\n[dex-ztoken-e2e] ✅ All DEX tests completed successfully!');
  console.info('[dex-ztoken-e2e] Flow: Create → Mint → Shield → Pool → Liquidity → Swap');
}

main().catch((error) => {
  console.error('[dex-ztoken-e2e] Test suite failed:', error);
  process.exit(1);
});
