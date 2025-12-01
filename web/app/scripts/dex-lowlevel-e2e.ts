/**
 * Low-Level DEX End-to-End Test
 * 
 * Tests DEX program instructions using SDK functions:
 * 1. Create pool with public tokens
 * 2. Add liquidity
 * 3. Remove liquidity
 * 4. Swap (public/public)
 * 5. Fee collection
 * 
 * Tests assume reset/bootstrap already happened (run-full-test-suite.sh handles this)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
  getMint
} from '@solana/spl-token';
import {
  createDexPool,
  addDexLiquidity,
  removeDexLiquidity,
  swapDex,
  getDexPoolState,
  calculateSwapOutput,
  calculateLPTokens
} from '../lib/sdk';
import { DEX_PROGRAM_ID } from '../lib/onchain/programIds';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { createWalletAdapter } from './utils/walletAdapter';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const FAUCET_BASE_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:3000/api/faucet';
const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (2n * 10n ** 9n).toString());
const MIN_SOL_BALANCE = BigInt(process.env.MIN_SOL_BALANCE ?? (1n * 10n ** 9n).toString());

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
  // Try faucet API first, fallback to direct requestAirdrop
  try {
    const response = await fetch(`${FAUCET_BASE_URL}/sol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: recipient.toBase58(), amountLamports: SOL_AIRDROP_LAMPORTS.toString() })
    });
    if (response.ok) {
      const { signature } = (await response.json()) as { signature: string };
      await confirmTransaction(connection, signature, 30000);
      // Wait for balance to update
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const balance = BigInt(await connection.getBalance(recipient, 'confirmed'));
        if (balance >= MIN_SOL_BALANCE) {
          return;
        }
        await sleep(1000);
      }
      throw new Error('SOL balance did not reach minimum threshold after faucet');
    }
  } catch (err) {
    console.warn(`[faucetSol] Faucet API failed, trying direct airdrop: ${err}`);
  }
  
  // Fallback to direct airdrop
  console.info(`[faucetSol] Using direct requestAirdrop for ${recipient.toBase58()}`);
  const signature = await connection.requestAirdrop(recipient, Number(SOL_AIRDROP_LAMPORTS));
  await confirmTransaction(connection, signature, 30000);
  
  // Verify balance
  const balance = BigInt(await connection.getBalance(recipient, 'confirmed'));
  if (balance < MIN_SOL_BALANCE) {
    throw new Error(`SOL balance ${balance} is below minimum ${MIN_SOL_BALANCE} after airdrop`);
  }
}

async function createMint(
  connection: Connection,
  payer: Keypair,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null
): Promise<Keypair> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_PROGRAM_ID
  });
  
  const initMintIx = createInitializeMintInstruction(
    mint.publicKey,
    decimals,
    mintAuthority,
    freezeAuthority,
    TOKEN_PROGRAM_ID
  );
  
  const tx = new Transaction().add(createAccountIx, initMintIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(payer, mint);
  
  const signature = await connection.sendRawTransaction(tx.serialize());
  await confirmTransaction(connection, signature, 30000);
  
  return mint;
}

async function mintTokens(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  authority: Keypair,
  amount: bigint,
  decimals: number
): Promise<string> {
  const mintToIx = createMintToInstruction(
    mint,
    destination,
    authority.publicKey,
    Number(amount),
    [],
    TOKEN_PROGRAM_ID
  );
  
  const tx = new Transaction().add(mintToIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(payer, authority);
  
  const signature = await connection.sendRawTransaction(tx.serialize());
  await confirmTransaction(connection, signature, 30000);
  
  return signature;
}

async function getOrCreateTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  const address = await getAssociatedTokenAddress(
    mint,
    owner,
    allowOwnerOffCurve,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const account = await connection.getAccountInfo(address);
  if (!account) {
    const createIx = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      address,
      owner,
      mint,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    const tx = new Transaction().add(createIx);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(payer);
    
    const signature = await connection.sendRawTransaction(tx.serialize());
    await confirmTransaction(connection, signature, 30000);
  }
  
  return address;
}

async function getTokenBalance(connection: Connection, tokenAccount: PublicKey): Promise<bigint> {
  try {
    const account = await getAccount(connection, tokenAccount);
    return BigInt(account.amount.toString());
  } catch {
    return 0n;
  }
}

async function waitForValidator(connection: Connection, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  console.info('[setup] Waiting for validator to be ready...');
  
  let initialSlot = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const slot = await connection.getSlot('confirmed');
      if (slot > 0) {
        if (initialSlot === 0) {
          initialSlot = slot;
          console.info(`[setup] ✓ Validator ready (slot: ${slot})`);
        } else if (slot > initialSlot) {
          console.info(`[setup] ✓ Validator is processing (slot advanced: ${initialSlot} -> ${slot})`);
          return;
        }
      }
    } catch (err) {
      // Continue waiting
    }
    await sleep(500);
  }
  
  // Check if validator is stuck (slot not advancing)
  const finalSlot = await connection.getSlot('confirmed').catch(() => 0);
  if (finalSlot === initialSlot && initialSlot > 0) {
    throw new Error(`Validator appears stuck at slot ${initialSlot}. Transaction processing may be frozen. Consider resetting the validator.`);
  }
  
  throw new Error('Validator did not become ready within timeout');
}

async function main() {
  console.info('[dex-lowlevel-e2e] ⚠️  This test file is outdated and needs to be updated for zToken-only DEX');
  console.info('[dex-lowlevel-e2e] ⚠️  The DEX now requires zTokens and proofClient/shieldProofs');
  console.info('[dex-lowlevel-e2e] ⚠️  Use dex-ztoken-e2e.ts for current DEX testing');
  console.info('[dex-lowlevel-e2e] ⚠️  Skipping all tests in this file');
  return;
  
  /* OLD CODE - commented out until test file is updated
  console.info('[dex-lowlevel-e2e] Starting DEX low-level E2E test suite');
  const connection = new Connection(RPC_URL, 'confirmed');
  
  // Wait for validator to be ready and processing
  await waitForValidator(connection);
  
  // Check if DEX program is deployed
  console.info('[setup] Checking if DEX program is deployed...');
  const dexProgramAccount = await connection.getAccountInfo(DEX_PROGRAM_ID, 'confirmed');
  if (!dexProgramAccount) {
    console.error('[setup] ✗ DEX program not deployed!');
    console.error('[setup]    Please deploy it first:');
    console.error('[setup]    solana program deploy target/deploy/ptf_dex.so --program-id target/deploy/ptf_dex-keypair.json --url http://127.0.0.1:8899');
    throw new Error('DEX program not deployed. Deploy it before running tests.');
  }
  console.info('[setup] ✓ DEX program is deployed');
  
  const user = Keypair.generate();
  
  console.info('[setup] Funding user with SOL via faucet');
  await faucetSol(connection, user.publicKey);
  
  console.info('[setup] Creating test mints');
  const mintA = await createMint(connection, user, 6, user.publicKey, user.publicKey);
  const mintB = await createMint(connection, user, 6, user.publicKey, user.publicKey);
  
  console.info(`[setup] ✓ Created mint A: ${mintA.publicKey.toBase58()}`);
  console.info(`[setup] ✓ Created mint B: ${mintB.publicKey.toBase58()}`);
  
  // Ensure canonical order (mint_a < mint_b)
  const [tokenA, tokenB] = mintA.publicKey.toBuffer().compare(mintB.publicKey.toBuffer()) < 0
    ? [mintA.publicKey, mintB.publicKey]
    : [mintB.publicKey, mintA.publicKey];
  
  console.info('[setup] Creating user token accounts');
  const userTokenAAccount = await getOrCreateTokenAccount(connection, user, tokenA, user.publicKey);
  const userTokenBAccount = await getOrCreateTokenAccount(connection, user, tokenB, user.publicKey);
  
  const initialAmountA = 1000n * 10n ** 6n; // 1000 tokens
  const initialAmountB = 2000n * 10n ** 6n; // 2000 tokens
  
  console.info('[setup] Minting initial tokens');
  await mintTokens(connection, user, tokenA, userTokenAAccount, user, initialAmountA, 6);
  await mintTokens(connection, user, tokenB, userTokenBAccount, user, initialAmountB, 6);
  
  console.info(`[setup] ✓ Minted ${initialAmountA / 10n ** 6n} tokens A to user`);
  console.info(`[setup] ✓ Minted ${initialAmountB / 10n ** 6n} tokens B to user`);
  
  // ============================================
  // TEST 1: Create Pool
  // ============================================
  console.info('\n[test-1] Testing create_pool instruction');
  
  const userAdapter = createWalletAdapter(user) as any;
  
  // Check if pool already exists
  const existingPool = await getDexPoolState(connection, tokenA, tokenB);
  if (existingPool) {
    console.warn('[test-1] ⚠️  Pool already exists (may be from previous test run)');
  } else {
    console.info('[test-1] Creating new pool...');
    
    try {
      const signature = await createDexPool({
        connection,
        wallet: userAdapter,
        tokenA: tokenA.toBase58(),
        tokenB: tokenB.toBase58(),
        initialAmountA,
        initialAmountB
      });
      
      console.info(`[test-1] ✓ Pool created successfully: ${signature}`);
      
      // Verify pool was created
      const poolState = await getDexPoolState(connection, tokenA, tokenB);
      if (!poolState) {
        throw new Error('Pool state not found after creation');
      }
      
      console.info(`[test-1] ✓ Pool state verified:`);
      console.info(`[test-1]   - LP Token Mint: ${poolState.lpTokenMint.toBase58()}`);
      console.info(`[test-1]   - Total LP Supply: ${poolState.totalLpSupply.toString()}`);
      console.info(`[test-1]   - Reserve A: ${poolState.publicReserveA.toString()}`);
      console.info(`[test-1]   - Reserve B: ${poolState.publicReserveB.toString()}`);
      
    } catch (error) {
      console.error('[test-1] ✗ Pool creation failed:', error);
      throw error;
    }
  }
  
  // ============================================
  // TEST 2: Add Liquidity
  // ============================================
  console.info('\n[test-2] Testing add_liquidity instruction');
  
  const addAmountA = 100n * 10n ** 6n; // 100 tokens
  const addAmountB = 200n * 10n ** 6n; // 200 tokens
  
  // Calculate expected LP tokens
  const poolState = await getDexPoolState(connection, tokenA, tokenB);
  if (!poolState) {
    throw new Error('Pool does not exist');
  }
  
  const expectedLp = calculateLPTokens(
    addAmountA,
    addAmountB,
    poolState.publicReserveA,
    poolState.publicReserveB,
    poolState.totalLpSupply
  );
  const minLpTokens = (expectedLp * 95n) / 100n; // 5% slippage tolerance
  
  console.info(`[test-2] Adding liquidity: ${addAmountA / 10n ** 6n} A, ${addAmountB / 10n ** 6n} B`);
  console.info(`[test-2] Expected LP tokens: ${expectedLp.toString()}`);
  
  // Mint additional tokens for adding liquidity
  await mintTokens(connection, user, tokenA, userTokenAAccount, user, addAmountA, 6);
  await mintTokens(connection, user, tokenB, userTokenBAccount, user, addAmountB, 6);
  
  // Ensure user LP token account exists before adding liquidity
  const poolStateData = await getDexPoolState(connection, tokenA, tokenB);
  if (!poolStateData) {
    throw new Error('Pool state not found');
  }
  
  // Wait a bit to ensure pool creation transaction is fully finalized
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Get the LP mint's program ID to use the correct token program
  let lpMintInfo = await connection.getAccountInfo(poolStateData.lpTokenMint, 'confirmed');
  if (!lpMintInfo) {
    // Retry a few times in case of timing issues
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      lpMintInfo = await connection.getAccountInfo(poolStateData.lpTokenMint, 'confirmed');
      if (lpMintInfo) break;
    }
    if (!lpMintInfo) {
      throw new Error(`LP token mint does not exist: ${poolStateData.lpTokenMint.toBase58()}`);
    }
  }
  
  const lpTokenProgramId = lpMintInfo.owner;
  if (!lpTokenProgramId.equals(TOKEN_PROGRAM_ID) && !lpTokenProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`LP token mint has invalid owner: ${lpTokenProgramId.toBase58()}`);
  }
  console.info(`[test-2] LP mint: ${poolStateData.lpTokenMint.toBase58()}, program ID: ${lpTokenProgramId.toBase58()}, data length: ${lpMintInfo.data.length}`);
  
  // Verify mint is initialized (data length should be 82 for a mint)
  if (lpMintInfo.data.length < 82) {
    throw new Error(`LP token mint appears uninitialized (data length: ${lpMintInfo.data.length}, expected: 82)`);
  }
  
  // Try to parse the mint to verify it's properly initialized
  try {
    const mintData = await getMint(connection, poolStateData.lpTokenMint, 'confirmed', lpTokenProgramId);
    console.info(`[test-2] LP mint parsed successfully: decimals=${mintData.decimals}, supply=${mintData.supply.toString()}, mintAuthority=${mintData.mintAuthority?.toBase58() || 'null'}`);
  } catch (error: any) {
    throw new Error(`LP token mint is not properly initialized: ${error.message}. This suggests the mint initialization in create_pool may have failed.`);
  }
  
  // Create user LP token account if it doesn't exist
  // Use the LP mint's actual program ID
  const userLpTokenAccount = await getOrCreateTokenAccount(
    connection,
    user,
    poolStateData.lpTokenMint,
    user.publicKey,
    false,
    lpTokenProgramId
  );
  console.info(`[test-2] User LP token account ready: ${userLpTokenAccount.toBase58()}`);
  
  // Check initial LP token balance
  let initialLpBalance = 0n;
  try {
    initialLpBalance = await getTokenBalance(connection, userLpTokenAccount);
  } catch {
    initialLpBalance = 0n;
  }
  console.info(`[test-2] Initial LP token balance: ${initialLpBalance.toString()}`);
  
  try {
    const signature = await addDexLiquidity({
      connection,
      wallet: userAdapter,
      tokenA: tokenA.toBase58(),
      tokenB: tokenB.toBase58(),
      amountA: addAmountA,
      amountB: addAmountB,
      minLpTokens
    });
    
    console.info(`[test-2] ✓ Liquidity added successfully: ${signature}`);
    
    // Verify pool state updated
    const updatedPool = await getDexPoolState(connection, tokenA, tokenB);
    if (!updatedPool) {
      throw new Error('Pool state not found after adding liquidity');
    }
    
    console.info(`[test-2] ✓ Pool state updated:`);
    console.info(`[test-2]   - New Reserve A: ${updatedPool.publicReserveA.toString()}`);
    console.info(`[test-2]   - New Reserve B: ${updatedPool.publicReserveB.toString()}`);
    console.info(`[test-2]   - New LP Supply: ${updatedPool.totalLpSupply.toString()}`);
    
    // Verify LP tokens were minted to user
    const finalLpBalance = await getTokenBalance(connection, userLpTokenAccount);
    const lpTokensReceived = finalLpBalance - initialLpBalance;
    console.info(`[test-2] Final LP token balance: ${finalLpBalance.toString()}`);
    console.info(`[test-2] LP tokens received: ${lpTokensReceived.toString()}`);
    
    if (lpTokensReceived === 0n) {
      throw new Error('No LP tokens were minted after adding liquidity');
    }
    
    console.info(`[test-2] ✓ LP tokens minted successfully: ${lpTokensReceived.toString()}`);
    
  } catch (error) {
    console.error('[test-2] ✗ Add liquidity failed:', error);
    throw error;
  }
  
  // ============================================
  // TEST 3: Swap
  // ============================================
  console.info('\n[test-3] Testing swap instruction');
  
  const swapAmountIn = 50n * 10n ** 6n; // 50 tokens
  
  // Get current reserves
  const swapPoolState = await getDexPoolState(connection, tokenA, tokenB);
  if (!swapPoolState) {
    throw new Error('Pool does not exist');
  }
  
  // Calculate expected output
  const expectedOutput = calculateSwapOutput(
    swapAmountIn,
    swapPoolState.publicReserveA,
    swapPoolState.publicReserveB,
    5 // 5 bps fee
  );
  const minAmountOut = (expectedOutput * 95n) / 100n; // 5% slippage tolerance
  
  console.info(`[test-3] Swapping ${swapAmountIn / 10n ** 6n} tokens A -> B`);
  console.info(`[test-3] Expected output: ${expectedOutput.toString()}, Min: ${minAmountOut.toString()}`);
  
  // Mint tokens for swap
  await mintTokens(connection, user, tokenA, userTokenAAccount, user, swapAmountIn, 6);
  
  try {
    const signature = await swapDex({
      connection,
      wallet: userAdapter,
      tokenA: tokenA.toBase58(),
      tokenB: tokenB.toBase58(),
      amountIn: swapAmountIn,
      minAmountOut,
      aToB: true // Swap A -> B
    });
    
    console.info(`[test-3] ✓ Swap executed successfully: ${signature}`);
    
    // Verify pool state updated
    const swappedPool = await getDexPoolState(connection, tokenA, tokenB);
    if (!swappedPool) {
      throw new Error('Pool state not found after swap');
    }
    
    console.info(`[test-3] ✓ Pool state after swap:`);
    console.info(`[test-3]   - Reserve A: ${swappedPool.publicReserveA.toString()} (should increase)`);
    console.info(`[test-3]   - Reserve B: ${swappedPool.publicReserveB.toString()} (should decrease)`);
    
  } catch (error) {
    console.error('[test-3] ✗ Swap failed:', error);
    throw error;
  }
  
  // ============================================
  // TEST 4: Remove Liquidity
  // ============================================
  console.info('\n[test-4] Testing remove_liquidity instruction');
  
  // Get user's LP token balance
  const finalPoolState = await getDexPoolState(connection, tokenA, tokenB);
  if (!finalPoolState) {
    throw new Error('Pool does not exist');
  }
  
  const removeLpTokenAccount = await getAssociatedTokenAddress(
    finalPoolState.lpTokenMint,
    user.publicKey,
    false,
    TOKEN_PROGRAM_ID,  // Use TOKEN_PROGRAM_ID to match LP mint
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const lpBalance = await getTokenBalance(connection, removeLpTokenAccount);
  console.info(`[test-4] User LP token balance: ${lpBalance.toString()}`);
  
  if (lpBalance === 0n) {
    console.warn('[test-4] ⚠️  No LP tokens to remove, skipping test');
  } else {
    const removeLpAmount = lpBalance / 2n; // Remove half
    
    // Calculate expected amounts
    const expectedAmountA = (removeLpAmount * finalPoolState.publicReserveA) / finalPoolState.totalLpSupply;
    const expectedAmountB = (removeLpAmount * finalPoolState.publicReserveB) / finalPoolState.totalLpSupply;
    const minAmountA = (expectedAmountA * 95n) / 100n;
    const minAmountB = (expectedAmountB * 95n) / 100n;
    
    console.info(`[test-4] Removing ${removeLpAmount.toString()} LP tokens`);
    console.info(`[test-4] Expected: ${expectedAmountA.toString()} A, ${expectedAmountB.toString()} B`);
    
    try {
      const signature = await removeDexLiquidity({
        connection,
        wallet: userAdapter,
        tokenA: tokenA.toBase58(),
        tokenB: tokenB.toBase58(),
        lpAmount: removeLpAmount,
        minAmountA,
        minAmountB
      });
      
      console.info(`[test-4] ✓ Liquidity removed successfully: ${signature}`);
      
      // Verify pool state updated
      const afterRemovePool = await getDexPoolState(connection, tokenA, tokenB);
      if (!afterRemovePool) {
        throw new Error('Pool state not found after removing liquidity');
      }
      
      console.info(`[test-4] ✓ Pool state after removal:`);
      console.info(`[test-4]   - Reserve A: ${afterRemovePool.publicReserveA.toString()}`);
      console.info(`[test-4]   - Reserve B: ${afterRemovePool.publicReserveB.toString()}`);
      console.info(`[test-4]   - LP Supply: ${afterRemovePool.totalLpSupply.toString()}`);
      
    } catch (error) {
      console.error('[test-4] ✗ Remove liquidity failed:', error);
      throw error;
    }
  }
  
  // ============================================
  // TEST 5: Create Pool with zToken flags (one token as zToken)
  // ============================================
  console.info('\n[test-5] Testing create_pool with zToken flags');
  
  // Create new mints for zToken test
  const zTokenMintA = await createMint(connection, user, 6, user.publicKey, user.publicKey);
  const zTokenMintB = await createMint(connection, user, 6, user.publicKey, user.publicKey);
  
  // Ensure canonical order
  const [zTokenA, zTokenB] = zTokenMintA.publicKey.toBuffer().compare(zTokenMintB.publicKey.toBuffer()) < 0
    ? [zTokenMintA.publicKey, zTokenMintB.publicKey]
    : [zTokenMintB.publicKey, zTokenMintA.publicKey];
  
  console.info(`[test-5] Created test mints:`);
  console.info(`[test-5]   - Token A: ${zTokenA.toBase58()}`);
  console.info(`[test-5]   - Token B: ${zTokenB.toBase58()}`);
  
  // Check if pool already exists
  const existingZTokenPool = await getDexPoolState(connection, zTokenA, zTokenB);
  if (existingZTokenPool) {
    console.warn('[test-5] ⚠️  Pool already exists (may be from previous test run)');
  } else {
    console.info('[test-5] Creating pool with token A as zToken (flag only, no actual zToken handling yet)...');
    
    // Note: Currently, zToken support is not fully implemented
    // This test verifies that pool creation works with zToken flags set
    // and that the flags are stored correctly in pool state
    
    try {
      const signature = await createDexPool({
        connection,
        wallet: userAdapter,
        tokenA: zTokenA.toBase58(),
        tokenB: zTokenB.toBase58(),
        initialAmountA: 1000n * 10n ** 6n,
        initialAmountB: 2000n * 10n ** 6n,
      });
      
      console.info(`[test-5] ✓ Pool created successfully: ${signature}`);
      
      // Verify pool state has correct flags
      const zTokenPoolState = await getDexPoolState(connection, zTokenA, zTokenB);
      if (!zTokenPoolState) {
        throw new Error('Pool state not found after creation');
      }
      
      // Note: zToken flags removed - DEX is now zToken-only
      console.info(`[test-5] ✓ Pool state verified (zToken-only DEX)`);
      
    } catch (error: any) {
      console.error('[test-5] ✗ Pool creation with zToken flags failed:', error.message);
      // Don't throw - zToken support is not fully implemented yet
      console.warn('[test-5] ⚠️  This is expected if zToken handling is not fully implemented');
    }
  }
  
  // ============================================
  // TEST 6: Edge Cases - Pool Creation
  // ============================================
  console.info('\n[test-6] Testing edge cases for pool creation');
  
  // Test: Very small amounts (dust)
  try {
    const dustMintA = await createMint(connection, user, 6, user.publicKey, user.publicKey);
    const dustMintB = await createMint(connection, user, 6, user.publicKey, user.publicKey);
    const [dustTokenA, dustTokenB] = dustMintA.publicKey.toBuffer().compare(dustMintB.publicKey.toBuffer()) < 0
      ? [dustMintA.publicKey, dustMintB.publicKey]
      : [dustMintB.publicKey, dustMintA.publicKey];
    
    const dustPool = await getDexPoolState(connection, dustTokenA, dustTokenB);
    if (!dustPool) {
      console.info('[test-6] Testing pool creation with minimal amounts (1 token each)...');
      try {
        const signature = await createDexPool({
          connection,
          wallet: userAdapter,
          tokenA: dustTokenA.toBase58(),
          tokenB: dustTokenB.toBase58(),
          initialAmountA: 1n * 10n ** 6n, // 1 token
          initialAmountB: 1n * 10n ** 6n, // 1 token
        });
        console.info(`[test-6] ✓ Pool created with minimal amounts: ${signature}`);
      } catch (error: any) {
        console.warn(`[test-6] ⚠️  Minimal amount pool creation failed (may be expected): ${error.message}`);
      }
    }
  } catch (error: any) {
    console.warn(`[test-6] ⚠️  Edge case test skipped: ${error.message}`);
  }
  
  // Test: Large amounts
  try {
    const largeMintA = await createMint(connection, user, 6, user.publicKey, user.publicKey);
    const largeMintB = await createMint(connection, user, 6, user.publicKey, user.publicKey);
    const [largeTokenA, largeTokenB] = largeMintA.publicKey.toBuffer().compare(largeMintB.publicKey.toBuffer()) < 0
      ? [largeMintA.publicKey, largeMintB.publicKey]
      : [largeMintB.publicKey, largeMintA.publicKey];
    
    // Mint tokens to user
    const largeUserAccountA = await getOrCreateTokenAccount(connection, user, largeTokenA, user.publicKey);
    const largeUserAccountB = await getOrCreateTokenAccount(connection, user, largeTokenB, user.publicKey);
    await mintTokens(connection, user, largeTokenA, largeUserAccountA, user, 1000000n * 10n ** 6n, 6);
    await mintTokens(connection, user, largeTokenB, largeUserAccountB, user, 2000000n * 10n ** 6n, 6);
    
    const largePool = await getDexPoolState(connection, largeTokenA, largeTokenB);
    if (!largePool) {
      console.info('[test-6] Testing pool creation with large amounts (1M tokens each)...');
      try {
        const signature = await createDexPool({
          connection,
          wallet: userAdapter,
          tokenA: largeTokenA.toBase58(),
          tokenB: largeTokenB.toBase58(),
          initialAmountA: 1000000n * 10n ** 6n, // 1M tokens
          initialAmountB: 2000000n * 10n ** 6n, // 2M tokens
        });
        console.info(`[test-6] ✓ Pool created with large amounts: ${signature}`);
      } catch (error: any) {
        console.warn(`[test-6] ⚠️  Large amount pool creation failed: ${error.message}`);
      }
    }
  } catch (error: any) {
    console.warn(`[test-6] ⚠️  Large amount test skipped: ${error.message}`);
  }
  
  console.info('[test-6] ✓ Edge case tests completed');
  
  console.info('\n✅ DEX low-level E2E test suite completed successfully!');
  console.info('   All tests passed: create_pool, add_liquidity, swap, remove_liquidity');
  console.info('   zToken flag test: pool creation with zToken flags works');
  console.info('   Edge cases: minimal and large amount pool creation tested');
}

  */
}

main().catch((error) => {
  console.error('[dex-lowlevel-e2e] Test failed:', error);
  process.exit(1);
});

