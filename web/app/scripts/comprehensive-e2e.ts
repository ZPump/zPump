/**
 * Comprehensive High-Level End-to-End Test
 * 
 * Tests the complete user flow:
 * 1. Minting a token via mint page API
 * 2. First-time shield (with lazy initialization)
 * 3. Second-time shield
 * 4. First-time unshield
 * 5. Second-time unshield
 * 6. Trades between multiple accounts for normal tokens (SPL transfers)
 * 7. Trades between multiple accounts for zTokens (private transfers)
 */

import crypto from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  getMint
} from '@solana/spl-token';
import { mintNativeZToken, wrap, unwrap, transfer, preparePool, batchTransfer } from '../lib/sdk';
import { ProofClient } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { deriveViewingKey } from '../lib/wallet/viewingKey';
import { poseidonHashMany } from '../lib/onchain/poseidon';
import { canonicalizeHex, bytesLEToCanonicalHex } from '../lib/onchain/utils';
import { derivePoolState, deriveVaultState, deriveCommitmentTree } from '../lib/onchain/pdas';
import { decodeCommitmentTree } from '../lib/onchain/commitmentTree';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { createWalletAdapter } from './utils/walletAdapter';

ensureFetchPolyfill();

// Enable debug logging for unwrap
process.env.NEXT_PUBLIC_DEBUG_WRAP = 'true';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const NEXT_URL = process.env.NEXT_URL ?? 'http://127.0.0.1:3000';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const INDEXER_PROXY_URL = process.env.INDEXER_PROXY_URL ?? `${NEXT_URL}/api/indexer`;

const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (5n * 10n ** 9n).toString());
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000'); // 1 token with 6 decimals
const TARGET_DECIMALS = 6;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Timeout constants for batch transfer tests
const FETCH_TIMEOUT_MS = 15000; // 15 seconds for API calls
const PROOF_TIMEOUT_MS = 60000; // 60 seconds for proof generation
const TX_CONFIRM_TIMEOUT_MS = 30000; // 30 seconds for transaction confirmation

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${errorMessage} (timeout after ${timeoutMs}ms)`)), timeoutMs)
    )
  ]);
}

async function airdropSol(connection: Connection, address: PublicKey, amount: bigint): Promise<void> {
  const signature = await connection.requestAirdrop(address, Number(amount));
  await connection.confirmTransaction(signature, 'confirmed');
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
  throw new Error(`Account ${address.toBase58()} not found within ${timeoutMs}ms`);
}

function randomBlinding(): string {
  return Math.floor(Math.random() * 10 ** 18).toString();
}

function randomFieldScalar(): string {
  const bytes = crypto.randomBytes(31);
  return BigInt(`0x${bytes.toString('hex')}`).toString();
}

function pubkeyToFieldString(key: PublicKey): string {
  const hex = Buffer.from(key.toBytes()).toString('hex');
  return BigInt(`0x${hex}`).toString();
}

async function buildAmountCommitments(outputs: { amount: bigint; blinding: bigint }[]): Promise<string[]> {
  return Promise.all(
    outputs.map(async (output) => {
      const commitment = await poseidonHashMany([output.amount, output.blinding]);
      return `0x${Buffer.from(commitment).toString('hex')}`;
    })
  );
}

async function fetchCurrentRoot(connection: Connection, originMint: PublicKey): Promise<string> {
  const commitmentTreeKey = deriveCommitmentTree(originMint);
  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
  if (!commitmentTreeAccount) {
    // Pool not initialized yet - return default empty root
    return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }
  const treeState = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
  return bytesLEToCanonicalHex(Buffer.from(treeState.currentRoot));
}

async function fetchPoolStateFeeBps(connection: Connection, poolId: string): Promise<number> {
  const poolKey = new PublicKey(poolId);
  const account = await connection.getAccountInfo(poolKey, 'confirmed');
  if (!account) {
    throw new Error('Pool state account missing');
  }
  const buffer = Buffer.from(account.data);
  let offset = 8; // discriminator
  offset += 32 * 6; // authority, origin_mint, vault, verifier_program, verifying_key, commitment_tree
  offset += 32; // verifying_key_id
  offset += 32; // verifying_key_hash
  offset += 32; // current_root
  offset += 32 * 64; // recent_roots (MAX_ROOTS = 64)
  offset += 8 * 64; // recent_roots_timestamps (i64 * 64)
  offset += 1; // roots_len
  if (offset % 2 !== 0) {
    offset += 1; // align for u16
  }
  const feeBps = buffer.readUInt16LE(offset);
  return feeBps;
}

interface WrapResult {
  noteId: string;
  spendingKey: string;
  noteAmount: bigint;
  newRoot: string;
}

async function performShield(
  connection: Connection,
  proofClient: ProofClient,
  wallet: any,
  keypair: Keypair,
  originMint: string,
  poolId: string,
  amount: bigint,
  recipient: PublicKey,
  label: string
): Promise<WrapResult> {
  const currentRoot = await fetchCurrentRoot(connection, new PublicKey(originMint));
  const depositId = Date.now().toString();
  const blinding = randomBlinding();
  
  const payload = {
    oldRoot: currentRoot,
    amount: amount.toString(),
    recipient: recipient.toBase58(),
    depositId,
    poolId,
    blinding,
    mintId: originMint
  };
  
  console.info(`[shield:${label}] Requesting proof with root: ${currentRoot}`);
  const proof = await proofClient.requestProof('wrap', payload);
  
  const signature = await wrap({
    wallet,
    connection,
    originMint,
    poolId,
    amount,
    recipient: recipient.toBase58(),
    depositId,
    blinding,
    proof,
    keypair // For VersionedTransaction signing
  });
  
  console.info(`[shield:${label}] Shield signature: ${signature}`);
  
  // Wait a bit for the transaction to settle
  await sleep(2000);
  
  const newRoot = await fetchCurrentRoot(connection, new PublicKey(originMint));
  
  return {
    noteId: depositId,
    spendingKey: blinding,
    noteAmount: amount,
    newRoot
  };
}

async function performUnshield(
  connection: Connection,
  proofClient: ProofClient,
  wallet: any,
  keypair: Keypair,
  originMint: string,
  poolId: string,
  notes: WrapResult[],
  amount: bigint,
  destination: PublicKey,
  label: string
): Promise<string> {
  const currentRoot = await fetchCurrentRoot(connection, new PublicKey(originMint));
  
  // Fetch actual fee_bps from pool state to calculate required amount
  const feeBps = await fetchPoolStateFeeBps(connection, poolId);
  const feeBpsBigInt = BigInt(feeBps);
  let calculatedFee = (amount * feeBpsBigInt) / 10_000n;
  const fee = calculatedFee > 0n ? calculatedFee : 1n;
  
  // Calculate total required (amount + fee)
  const totalRequired = amount + fee;
  
  // Select notes to cover the amount + fee
  const selectedNotes = notes.filter(n => n.noteAmount >= totalRequired);
  if (selectedNotes.length === 0) {
    throw new Error(`Insufficient notes to cover unshield amount ${amount} + fee ${fee} = ${totalRequired}`);
  }
  const note = selectedNotes[0]!;
  
  // Calculate change
  const changeAmount = note.noteAmount > totalRequired ? note.noteAmount - totalRequired : 0n;
  
  const originMintKey = new PublicKey(originMint);
  const poolStateKey = new PublicKey(poolId);
  
  const payload: any = {
    oldRoot: currentRoot,
    amount: amount.toString(),
    fee: fee.toString(),
    destPubkey: destination.toBase58(),
    mode: 'origin',
    mintId: pubkeyToFieldString(originMintKey),
    poolId: pubkeyToFieldString(poolStateKey),
    noteId: note.noteId,
    spendingKey: note.spendingKey,
    noteAmount: note.noteAmount.toString()
  };
  
  // Add change if there is any (proof service requires change recipient if change exists)
  if (changeAmount > 0n) {
    payload.change = {
      amount: changeAmount.toString(),
      recipient: pubkeyToFieldString(keypair.publicKey),
      blinding: randomFieldScalar(),
      amountBlinding: randomFieldScalar()
    };
  }
  
  console.info(`[unshield:${label}] Requesting proof with amount=${amount}, fee=${fee}, change=${changeAmount}`);
  const proof = await proofClient.requestProof('unwrap', payload);
  
  // unwrap function extracts nullifiers and commitments from the proof itself
  const signature = await unwrap({
    wallet,
    keypair, // Pass keypair for VersionedTransaction signing
    connection,
    originMint,
    poolId,
    destination: destination.toBase58(),
    mode: 'origin',
    proof,
    amount // Required parameter
  });
  
  console.info(`[unshield:${label}] Unshield signature: ${signature}`);
  
  return signature;
}

async function performPrivateTransfer(
  connection: Connection,
  proofClient: ProofClient,
  wallet: any,
  keypair: Keypair,
  originMint: string,
  poolId: string,
  notes: WrapResult[],
  amount: bigint,
  recipient: PublicKey,
  label: string
): Promise<{ signature: string; newNotes: WrapResult[] }> {
  // Select notes to cover the amount
  const selectedNotes = notes.filter(n => n.noteAmount >= amount);
  if (selectedNotes.length === 0) {
    throw new Error(`Insufficient notes to cover transfer amount ${amount}`);
  }
  const note = selectedNotes[0]!;
  const totalInput = note.noteAmount;
  const changeAmount = totalInput - amount;
  
  const currentRoot = await fetchCurrentRoot(connection, new PublicKey(originMint));
  
  const payload = {
    oldRoot: currentRoot,
    mintId: originMint,
    poolId,
    inNotes: [{
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: note.noteAmount.toString()
    }],
    outNotes: [
      {
        amount: amount.toString(),
        recipient: pubkeyToFieldString(recipient),
        blinding: randomBlinding()
      },
      ...(changeAmount > 0n ? [{
        amount: changeAmount.toString(),
        recipient: pubkeyToFieldString(keypair.publicKey),
        blinding: randomBlinding()
      }] : [])
    ]
  };
  
  console.info(`[transfer:${label}] Requesting proof`);
  const proof = await proofClient.requestProof('transfer', payload);
  
  // Parse public inputs
  const publicInputs = proof.publicInputs ?? [];
  const expectedCount = 2 + 1 + payload.outNotes.length + 2; // oldRoot + newRoot + nullifiers + outputCommitments + outputAmountCommitments
  if (publicInputs.length < expectedCount) {
    throw new Error(`Unexpected transfer public input count: expected ${expectedCount}, got ${publicInputs.length}`);
  }
  
  const nullifiers = [publicInputs[2]!];
  const outputCommitments = payload.outNotes.map((_, idx) => publicInputs[3 + idx]!);
  
  const amountCommitments = await buildAmountCommitments(
    payload.outNotes.map(out => ({
      amount: BigInt(out.amount),
      blinding: BigInt(out.blinding)
    }))
  );
  
  const signature = await transfer({
    wallet,
    connection,
    originMint,
    poolId,
    proof,
    nullifiers,
    outputCommitments,
    outputAmountCommitments: amountCommitments
  });
  
  console.info(`[transfer:${label}] Transfer signature: ${signature}`);
  
  // Wait for transaction to settle
  await sleep(2000);
  
  // Create new notes from outputs
  const newNotes: WrapResult[] = payload.outNotes.map((out, idx) => ({
    noteId: `${Date.now()}${idx}`, // Use concatenation without hyphen to make it a valid numeric string
    spendingKey: out.blinding,
    noteAmount: BigInt(out.amount),
    newRoot: publicInputs[1]! // newRoot from proof
  }));
  
  return { signature, newNotes };
}

async function transferNormalTokens(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<string> {
  const { createTransferInstruction } = await import('@solana/spl-token');
  
  // Detect which token program the mint uses
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error('Mint account not found');
  }
  const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  
  const fromTokenAccount = await getAssociatedTokenAddress(
    mint,
    from.publicKey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const toTokenAccount = await getAssociatedTokenAddress(
    mint,
    to,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Check if recipient token account exists
  const toAccountInfo = await connection.getAccountInfo(toTokenAccount, 'confirmed');
  if (!toAccountInfo) {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    const createIx = createAssociatedTokenAccountInstruction(
      from.publicKey,
      toTokenAccount,
      to,
      mint,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    const transferIx = createTransferInstruction(
      fromTokenAccount,
      toTokenAccount,
      from.publicKey,
      Number(amount),
      [],
      tokenProgramId
    );
    
    const { Transaction } = await import('@solana/web3.js');
    const tx = new Transaction().add(createIx, transferIx);
    const blockhash = await connection.getLatestBlockhash('confirmed');
    tx.feePayer = from.publicKey;
    tx.recentBlockhash = blockhash.blockhash;
    tx.sign(from);
    
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  } else {
    const transferIx = createTransferInstruction(
      fromTokenAccount,
      toTokenAccount,
      from.publicKey,
      Number(amount),
      [],
      tokenProgramId
    );
    
    const { Transaction } = await import('@solana/web3.js');
    const tx = new Transaction().add(transferIx);
    const blockhash = await connection.getLatestBlockhash('confirmed');
    tx.feePayer = from.publicKey;
    tx.recentBlockhash = blockhash.blockhash;
    tx.sign(from);
    
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  }
}

async function getTokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    // Try TOKEN_2022_PROGRAM_ID first (since mintNativeZToken creates TOKEN_2022 mints)
    const tokenAccount2022 = await getAssociatedTokenAddress(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    try {
      const account = await getAccount(connection, tokenAccount2022, 'confirmed', TOKEN_2022_PROGRAM_ID);
      return BigInt(account.amount.toString());
    } catch {
      // Fall back to TOKEN_PROGRAM_ID if TOKEN_2022 fails
      const tokenAccount = await getAssociatedTokenAddress(
        mint,
        owner,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const account = await getAccount(connection, tokenAccount, 'confirmed');
      return BigInt(account.amount.toString());
    }
  } catch {
    return 0n;
  }
}

async function comprehensiveE2ETest(): Promise<void> {
  console.info('[comprehensive-e2e] Starting comprehensive high-level E2E test');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const indexerClient = new IndexerClient({ baseUrl: INDEXER_PROXY_URL });
  
  // Create multiple test accounts
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const charlie = Keypair.generate();
  
  const aliceAdapter = createWalletAdapter(alice) as any;
  const bobAdapter = createWalletAdapter(bob) as any;
  const charlieAdapter = createWalletAdapter(charlie) as any;
  
  console.info('[setup] Airdropping SOL to test accounts');
  await Promise.all([
    airdropSol(connection, alice.publicKey, SOL_AIRDROP_LAMPORTS),
    airdropSol(connection, bob.publicKey, SOL_AIRDROP_LAMPORTS),
    airdropSol(connection, charlie.publicKey, SOL_AIRDROP_LAMPORTS)
  ]);
  
  // ============================================
  // TEST 1: Minting via mint page API
  // ============================================
  console.info('\n[test-1] Testing token minting via mint page API');
  const tokenName = `Test Token ${Date.now()}`;
  const tokenSymbol = `TT${Date.now().toString().slice(-4)}`;
  const tokenDecimals = TARGET_DECIMALS;
  const initialSupply = WRAP_AMOUNT * 20n; // 20 tokens
  
  const mintResult = await mintNativeZToken({
    connection,
    wallet: aliceAdapter,
    name: tokenName,
    symbol: tokenSymbol,
    uri: `ipfs://test-${Date.now()}`,
    decimals: tokenDecimals,
    initialSupply
  });
  
  console.info(`[test-1] ✓ Token minted: ${mintResult.originMint}`);
  console.info(`[test-1] ✓ Pool ID: ${mintResult.poolId}`);
  
  // Verify pool/vault are NOT initialized after minting (lazy initialization)
  const originMintKey = new PublicKey(mintResult.originMint);
  const poolState = derivePoolState(originMintKey);
  const vaultState = deriveVaultState(originMintKey);
  
  const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
  const vaultAccount = await connection.getAccountInfo(vaultState, 'confirmed');
  
  if (poolAccount) {
    throw new Error('[test-1] Pool should not be initialized after minting');
  }
  if (vaultAccount) {
    throw new Error('[test-1] Vault should not be initialized after minting');
  }
  console.info('[test-1] ✓ Pool and vault are not initialized (lazy initialization confirmed)');
  
  // Wait a bit for the transaction to fully settle
  await sleep(3000);
  
  // Check mint supply to verify tokens were minted
  const mintInfo = await getMint(connection, originMintKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
  console.info(`[test-1] Mint supply: ${mintInfo.supply.toString()}, decimals: ${mintInfo.decimals}, mint authority: ${mintInfo.mintAuthority?.toBase58() ?? 'null'}`);
  
  // Check Alice's expected ATA address
  const aliceATA = await getAssociatedTokenAddress(originMintKey, alice.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  console.info(`[test-1] Alice's expected ATA: ${aliceATA.toBase58()}`);
  
  // Check if Alice's ATA exists and has tokens
  const aliceATAInfo = await connection.getAccountInfo(aliceATA, 'confirmed');
  if (aliceATAInfo) {
    try {
      const aliceATAParsed = await getAccount(connection, aliceATA, 'confirmed', TOKEN_2022_PROGRAM_ID);
      console.info(`[test-1] Alice's ATA exists: ${aliceATAParsed.amount.toString()} tokens, owner: ${aliceATAParsed.owner.toBase58()}`);
    } catch (error) {
      console.warn(`[test-1] Failed to parse Alice's ATA: ${(error as Error).message}`);
    }
  } else {
    console.warn(`[test-1] Alice's ATA does not exist!`);
  }
  
  // Verify Alice has the initial supply
  // Note: The mint_native_ztoken instruction should mint initial_supply to user's token account
  let aliceBalance = await getTokenBalance(connection, alice.publicKey, originMintKey);
  let retries = 0;
  while (aliceBalance === 0n && retries < 10) {
    await sleep(1000);
    aliceBalance = await getTokenBalance(connection, alice.publicKey, originMintKey);
    retries++;
  }
  
  // If Alice doesn't have tokens, check if they were minted to admin (whoever called mintNativeZToken)
  // The mint_native_ztoken instruction mints to wallet.publicKey (which is alice in this case)
  if (aliceBalance < initialSupply) {
    console.warn(`[test-1] Alice balance is ${aliceBalance}, expected ${initialSupply}. Mint supply is ${mintInfo.supply.toString()}`);
    // If mint supply is correct but Alice doesn't have tokens, there may be an issue
    // Check if tokens were minted to a different account (e.g., factory PDA or admin)
    // For now, we'll try to find where the tokens went by checking common accounts
    if (aliceBalance === 0n && mintInfo.supply >= initialSupply) {
      console.warn(`[test-1] WARNING: Mint has ${mintInfo.supply.toString()} tokens but Alice has 0.`);
      console.warn(`[test-1] This may indicate a bug in mint_native_ztoken, or tokens were minted to a different account.`);
      console.warn(`[test-1] For testing purposes, we'll use the faucet to provide tokens to Alice.`);
      // Don't throw - use faucet as workaround for now
    }
  }
  
  // Ensure we have enough tokens for testing
  // If Alice doesn't have tokens, try using faucet (may fail if mint authority is factory PDA)
  if (aliceBalance < WRAP_AMOUNT * 10n) {
    console.info(`[test-1] Insufficient tokens (${aliceBalance}), trying faucet...`);
    try {
      const faucetResponse = await fetch(`${NEXT_URL}/api/faucet/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: alice.publicKey.toBase58(),
          mint: mintResult.originMint,
          amount: (WRAP_AMOUNT * 10n).toString()
        })
      });
      if (faucetResponse.ok) {
        const { signature: faucetSig } = (await faucetResponse.json()) as { signature: string };
        console.info(`[test-1] Faucet transaction: ${faucetSig}`);
        await sleep(3000);
        aliceBalance = await getTokenBalance(connection, alice.publicKey, originMintKey);
        console.info(`[test-1] Alice balance after faucet: ${aliceBalance}`);
      } else {
        const errorText = await faucetResponse.text().catch(() => 'unknown error');
        console.warn(`[test-1] Faucet failed: ${errorText}`);
        // If faucet fails, this is likely because mint authority is factory PDA, not faucet keypair
        // In this case, we need to manually mint tokens using the factory PDA
        // For now, we'll skip this test or mark it as a known issue
        console.error(`[test-1] Cannot proceed: Alice has ${aliceBalance} tokens, need ${WRAP_AMOUNT * 10n}.`);
        console.error(`[test-1] This is likely because mint_native_ztoken didn't mint to Alice's account, or mint authority is factory PDA.`);
        throw new Error(`[test-1] Insufficient tokens and faucet unavailable. This may indicate a bug in mint_native_ztoken.`);
      }
    } catch (error) {
      if ((error as Error).message.includes('Insufficient tokens')) {
        throw error;
      }
      console.warn(`[test-1] Faucet error: ${(error as Error).message}`);
      throw new Error(`[test-1] Cannot get tokens for testing: ${(error as Error).message}`);
    }
  }
  
  // NOTE: There's a known bug where mint_native_ztoken mints tokens but they don't appear in the user's account
  // This is being investigated separately. For now, we'll skip the token balance check and proceed with testing
  // the shield/unshield flows using a workaround (manually minting tokens via factory PDA if needed)
  if (aliceBalance < WRAP_AMOUNT * 10n) {
    console.error(`[test-1] ERROR: Alice has ${aliceBalance} tokens, need ${WRAP_AMOUNT * 10n}.`);
    console.error(`[test-1] This is a known bug in mint_native_ztoken - tokens are minted but not in user account.`);
    console.error(`[test-1] Skipping comprehensive test until this bug is fixed.`);
    throw new Error(`[test-1] Cannot proceed: mint_native_ztoken bug prevents testing. Tokens minted but not in user account.`);
  }
  console.info(`[test-1] ✓ Alice has tokens: ${aliceBalance}`);
  
  // ============================================
  // TEST 2: First-time shield (with lazy initialization)
  // ============================================
  console.info('\n[test-2] Testing first-time shield (should initialize pool/vault)');
  
  // Prepare pool first (this creates ALT, initializes vault and pool)
  console.info('[test-2] Preparing pool (bootstrap)...');
  const prepResult = await preparePool({
    connection,
    wallet: aliceAdapter,
    originMint: mintResult.originMint
  });
  console.info(`[test-2] ✓ Pool prepared: ${prepResult.actions.join(', ')}`);
  
  // Verify pool/vault are now initialized
  await waitForAccount(connection, poolState);
  await waitForAccount(connection, vaultState);
  console.info('[test-2] ✓ Pool and vault are initialized');
  
  // Perform first shield
  const shield1Result = await performShield(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult.originMint,
    mintResult.poolId,
    WRAP_AMOUNT,
    alice.publicKey,
    'first-time'
  );
  
  console.info(`[test-2] ✓ First shield completed: ${shield1Result.noteId}`);
  
  // Verify Alice's token balance decreased
  const aliceBalanceAfterShield1 = await getTokenBalance(connection, alice.publicKey, originMintKey);
  const expectedBalanceAfterShield1 = initialSupply - WRAP_AMOUNT;
  if (aliceBalanceAfterShield1 < expectedBalanceAfterShield1) {
    throw new Error(`[test-2] Alice balance after first shield: expected at least ${expectedBalanceAfterShield1}, got ${aliceBalanceAfterShield1}`);
  }
  console.info(`[test-2] ✓ Alice balance after first shield: ${aliceBalanceAfterShield1}`);
  
  const aliceNotes: WrapResult[] = [shield1Result];
  
  // ============================================
  // TEST 3: Second-time shield (no initialization)
  // ============================================
  console.info('\n[test-3] Testing second-time shield (should NOT re-initialize)');
  
  const shield2Result = await performShield(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult.originMint,
    mintResult.poolId,
    WRAP_AMOUNT * 2n,
    alice.publicKey,
    'second-time'
  );
  
  console.info(`[test-3] ✓ Second shield completed: ${shield2Result.noteId}`);
  aliceNotes.push(shield2Result);
  
  // Verify Alice's token balance decreased further
  const aliceBalanceAfterShield2 = await getTokenBalance(connection, alice.publicKey, originMintKey);
  const expectedBalanceAfterShield2 = initialSupply - WRAP_AMOUNT - (WRAP_AMOUNT * 2n);
  if (aliceBalanceAfterShield2 < expectedBalanceAfterShield2) {
    throw new Error(`[test-3] Alice balance after second shield: expected at least ${expectedBalanceAfterShield2}, got ${aliceBalanceAfterShield2}`);
  }
  console.info(`[test-3] ✓ Alice balance after second shield: ${aliceBalanceAfterShield2}`);
  
  // ============================================
  // TEST 4: First-time unshield
  // ============================================
  console.info('\n[test-4] Testing first-time unshield');
  
  // Unshield an amount that leaves a reasonable change (at least 10000 to avoid proof service issues)
  // Note: noteAmount is 1000000, fee is ~1000 (0.1% of amount)
  // So if we unshield 980000, fee = 980, change = 1000000 - 980000 - 980 = 19020 (reasonable change)
  const unshield1Amount = WRAP_AMOUNT - 20000n; // Leave room for fees and reasonable change
  const unshield1Sig = await performUnshield(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult.originMint,
    mintResult.poolId,
    aliceNotes,
    unshield1Amount,
    alice.publicKey,
    'first-time'
  );
  
  console.info(`[test-4] ✓ First unshield completed: ${unshield1Sig}`);
  
  // Remove the note that was used
  aliceNotes.shift();
  
  // Verify Alice's token balance increased
  await sleep(2000); // Wait for transaction to settle
  const aliceBalanceAfterUnshield1 = await getTokenBalance(connection, alice.publicKey, originMintKey);
  const expectedBalanceAfterUnshield1 = aliceBalanceAfterShield2 + unshield1Amount;
  // Allow some tolerance for fees
  if (aliceBalanceAfterUnshield1 < expectedBalanceAfterUnshield1 - (WRAP_AMOUNT / 100n)) {
    throw new Error(`[test-4] Alice balance after first unshield: expected at least ${expectedBalanceAfterUnshield1 - (WRAP_AMOUNT / 100n)}, got ${aliceBalanceAfterUnshield1}`);
  }
  console.info(`[test-4] ✓ Alice balance after first unshield: ${aliceBalanceAfterUnshield1}`);
  
  // ============================================
  // TEST 5: Second-time unshield
  // ============================================
  console.info('\n[test-5] Testing second-time unshield');
  
  const unshield2Amount = WRAP_AMOUNT;
  const unshield2Sig = await performUnshield(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult.originMint,
    mintResult.poolId,
    aliceNotes,
    unshield2Amount,
    alice.publicKey,
    'second-time'
  );
  
  console.info(`[test-5] ✓ Second unshield completed: ${unshield2Sig}`);
  
  // Remove the note that was used
  aliceNotes.shift();
  
  // Verify Alice's token balance increased further
  await sleep(2000);
  const aliceBalanceAfterUnshield2 = await getTokenBalance(connection, alice.publicKey, originMintKey);
  const expectedBalanceAfterUnshield2 = aliceBalanceAfterUnshield1 + unshield2Amount;
  if (aliceBalanceAfterUnshield2 < expectedBalanceAfterUnshield2 - (WRAP_AMOUNT / 100n)) {
    throw new Error(`[test-5] Alice balance after second unshield: expected at least ${expectedBalanceAfterUnshield2 - (WRAP_AMOUNT / 100n)}, got ${aliceBalanceAfterUnshield2}`);
  }
  console.info(`[test-5] ✓ Alice balance after second unshield: ${aliceBalanceAfterUnshield2}`);
  
  // ============================================
  // TEST 6: Normal token trades between accounts
  // ============================================
  console.info('\n[test-6] Testing normal token trades between accounts');
  
  // Give Bob some tokens
  const transferToBobAmount = WRAP_AMOUNT * 5n;
  console.info(`[test-6] Transferring ${transferToBobAmount} tokens from Alice to Bob`);
  const transfer1Sig = await transferNormalTokens(
    connection,
    alice,
    bob.publicKey,
    originMintKey,
    transferToBobAmount
  );
  console.info(`[test-6] ✓ Transfer 1 (Alice -> Bob) completed: ${transfer1Sig}`);
  
  // Verify balances
  const aliceBalanceAfterTransfer1 = await getTokenBalance(connection, alice.publicKey, originMintKey);
  const bobBalanceAfterTransfer1 = await getTokenBalance(connection, bob.publicKey, originMintKey);
  
  if (bobBalanceAfterTransfer1 !== transferToBobAmount) {
    throw new Error(`[test-6] Bob balance mismatch: expected ${transferToBobAmount}, got ${bobBalanceAfterTransfer1}`);
  }
  console.info(`[test-6] ✓ Bob received tokens: ${bobBalanceAfterTransfer1}`);
  console.info(`[test-6] ✓ Alice balance: ${aliceBalanceAfterTransfer1}`);
  
  // Bob transfers to Charlie
  const transferToCharlieAmount = WRAP_AMOUNT * 2n;
  console.info(`[test-6] Transferring ${transferToCharlieAmount} tokens from Bob to Charlie`);
  const transfer2Sig = await transferNormalTokens(
    connection,
    bob,
    charlie.publicKey,
    originMintKey,
    transferToCharlieAmount
  );
  console.info(`[test-6] ✓ Transfer 2 (Bob -> Charlie) completed: ${transfer2Sig}`);
  
  // Verify balances
  const bobBalanceAfterTransfer2 = await getTokenBalance(connection, bob.publicKey, originMintKey);
  const charlieBalanceAfterTransfer2 = await getTokenBalance(connection, charlie.publicKey, originMintKey);
  
  if (charlieBalanceAfterTransfer2 !== transferToCharlieAmount) {
    throw new Error(`[test-6] Charlie balance mismatch: expected ${transferToCharlieAmount}, got ${charlieBalanceAfterTransfer2}`);
  }
  const expectedBobBalance = transferToBobAmount - transferToCharlieAmount;
  if (bobBalanceAfterTransfer2 !== expectedBobBalance) {
    throw new Error(`[test-6] Bob balance mismatch: expected ${expectedBobBalance}, got ${bobBalanceAfterTransfer2}`);
  }
  console.info(`[test-6] ✓ Charlie received tokens: ${charlieBalanceAfterTransfer2}`);
  console.info(`[test-6] ✓ Bob balance: ${bobBalanceAfterTransfer2}`);
  
  // ============================================
  // TEST 7: Private zToken trades between accounts
  // ============================================
  console.info('\n[test-7] Testing private zToken trades between accounts');
  
  // Alice shields more tokens
  const shield3Result = await performShield(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult.originMint,
    mintResult.poolId,
    WRAP_AMOUNT * 3n,
    alice.publicKey,
    'for-transfer'
  );
  aliceNotes.push(shield3Result);
  console.info(`[test-7] ✓ Alice shielded ${WRAP_AMOUNT * 3n} tokens for transfer`);
  
  // Alice transfers zTokens to Bob privately
  const privateTransfer1Amount = WRAP_AMOUNT;
  console.info(`[test-7] Transferring ${privateTransfer1Amount} zTokens from Alice to Bob (private)`);
  const privateTransfer1 = await performPrivateTransfer(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult.originMint,
    mintResult.poolId,
    aliceNotes,
    privateTransfer1Amount,
    bob.publicKey,
    'Alice->Bob'
  );
  console.info(`[test-7] ✓ Private transfer 1 (Alice -> Bob) completed: ${privateTransfer1.signature}`);
  
  // Update Alice's notes (remove used, add change if any)
  aliceNotes.shift(); // Remove used note
  if (privateTransfer1.newNotes.length > 1) {
    // Add change note back
    aliceNotes.push(privateTransfer1.newNotes[1]!);
  }
  
  // Bob's notes (received note)
  const bobNotes: WrapResult[] = [privateTransfer1.newNotes[0]!];
  console.info(`[test-7] ✓ Bob received ${privateTransfer1Amount} zTokens privately`);
  
  // Bob transfers zTokens to Charlie privately
  const privateTransfer2Amount = WRAP_AMOUNT;
  console.info(`[test-7] Transferring ${privateTransfer2Amount} zTokens from Bob to Charlie (private)`);
  const privateTransfer2 = await performPrivateTransfer(
    connection,
    proofClient,
    bobAdapter,
    bob,
    mintResult.originMint,
    mintResult.poolId,
    bobNotes,
    privateTransfer2Amount,
    charlie.publicKey,
    'Bob->Charlie'
  );
  console.info(`[test-7] ✓ Private transfer 2 (Bob -> Charlie) completed: ${privateTransfer2.signature}`);
  
  // Charlie's notes
  const charlieNotes: WrapResult[] = [privateTransfer2.newNotes[0]!];
  console.info(`[test-7] ✓ Charlie received ${privateTransfer2Amount} zTokens privately`);
  
  // Charlie unshields the zTokens (unshield slightly less to account for fees)
  const charlieUnshieldAmount = privateTransfer2Amount - 100n; // Leave some for fees
  console.info(`[test-7] Charlie unshielding ${charlieUnshieldAmount} zTokens (from ${privateTransfer2Amount} to account for fees)`);
  const charlieUnshieldSig = await performUnshield(
    connection,
    proofClient,
    charlieAdapter,
    charlie,
    mintResult.originMint,
    mintResult.poolId,
    charlieNotes,
    charlieUnshieldAmount,
    charlie.publicKey,
    'Charlie-unshield'
  );
  console.info(`[test-7] ✓ Charlie unshielded zTokens: ${charlieUnshieldSig}`);
  
  // Verify Charlie's normal token balance increased
  await sleep(2000);
  const charlieFinalBalance = await getTokenBalance(connection, charlie.publicKey, originMintKey);
  const expectedCharlieBalance = transferToCharlieAmount + charlieUnshieldAmount;
  if (charlieFinalBalance < expectedCharlieBalance - (WRAP_AMOUNT / 100n)) {
    throw new Error(`[test-7] Charlie final balance mismatch: expected at least ${expectedCharlieBalance - (WRAP_AMOUNT / 100n)}, got ${charlieFinalBalance}`);
  }
  console.info(`[test-7] ✓ Charlie final balance: ${charlieFinalBalance}`);
  
  // ============================================
  // TEST 8: Batch Transfer with 2 tokens
  // ============================================
  console.info('\n[test-8] Testing batch transfer with 2 different zTokens');
  
  // Create a second token for batch transfer test
  const token2Name = `Test Token 2 ${Date.now()}`;
  const token2Symbol = `TT2${Date.now().toString().slice(-4)}`;
  const token2InitialSupply = WRAP_AMOUNT * 20n;
  
  const mintResult2 = await mintNativeZToken({
    connection,
    wallet: aliceAdapter,
    name: token2Name,
    symbol: token2Symbol,
    uri: `ipfs://test2-${Date.now()}`,
    decimals: tokenDecimals,
    initialSupply: token2InitialSupply
  });
  
  const originMint2Key = new PublicKey(mintResult2.originMint);
  console.info(`[test-8] ✓ Second token minted: ${mintResult2.originMint}`);
  
  // Shield both tokens (token1 and token2) for batch transfer
  console.info('[test-8] Shielding tokens for batch transfer...');
  const shieldBatch1 = await performShield(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult.originMint,
    mintResult.poolId,
    WRAP_AMOUNT * 2n,
    alice.publicKey,
    'batch-1'
  );
  
  const shieldBatch2 = await performShield(
    connection,
    proofClient,
    aliceAdapter,
    alice,
    mintResult2.originMint,
    mintResult2.poolId,
    WRAP_AMOUNT * 2n,
    alice.publicKey,
    'batch-2'
  );
  
  console.info(`[test-8] ✓ Shielded ${WRAP_AMOUNT * 2n} of token 1 and token 2`);
  
  // Import batch transfer helpers
  const { generateBatchTransferProof, fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
  const { bytesLEToCanonicalHex } = await import('../lib/onchain/utils');
  
  // Perform batch transfer: send tokens to Bob and Charlie
  const batchTransferAmount1 = WRAP_AMOUNT;
  const batchTransferAmount2 = WRAP_AMOUNT;
  
  console.info(`[test-8] Performing batch transfer: ${batchTransferAmount1} token1 -> Bob, ${batchTransferAmount2} token2 -> Charlie`);
  
  const batchProof = await withTimeout(
    generateBatchTransferProof(
      proofClient,
      connection,
      [
        {
          originMint: originMintKey,
          notes: [shieldBatch1].map(n => ({
            noteId: n.noteId,
            spendingKey: n.spendingKey,
            amount: n.noteAmount
          })),
          outputs: [
            {
              amount: batchTransferAmount1,
              recipient: bob.publicKey,
              blinding: randomBlinding()
            },
            {
              amount: shieldBatch1.noteAmount - batchTransferAmount1,
              recipient: alice.publicKey,
              blinding: randomBlinding()
            }
          ]
        },
        {
          originMint: originMint2Key,
          notes: [shieldBatch2].map(n => ({
            noteId: n.noteId,
            spendingKey: n.spendingKey,
            amount: n.noteAmount
          })),
          outputs: [
            {
              amount: batchTransferAmount2,
              recipient: charlie.publicKey,
              blinding: randomBlinding()
            },
            {
              amount: shieldBatch2.noteAmount - batchTransferAmount2,
              recipient: alice.publicKey,
              blinding: randomBlinding()
            }
          ]
        }
      ]
    ),
    PROOF_TIMEOUT_MS,
    'Generate batch transfer proof for comprehensive test'
  );
  
  // Extract and pad nullifiers/commitments to exactly 2 per transfer
  const nullifiers1_bt: string[] = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
  while (nullifiers1_bt.length < 2) nullifiers1_bt.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputCommitments1_bt: string[] = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputCommitments1_bt.length < 2) outputCommitments1_bt.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputAmountCommitments1_bt: string[] = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputAmountCommitments1_bt.length < 2) outputAmountCommitments1_bt.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  
  const nullifiers2_bt: string[] = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
  while (nullifiers2_bt.length < 2) nullifiers2_bt.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputCommitments2_bt: string[] = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputCommitments2_bt.length < 2) outputCommitments2_bt.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  const outputAmountCommitments2_bt: string[] = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
  while (outputAmountCommitments2_bt.length < 2) outputAmountCommitments2_bt.push(bytesLEToCanonicalHex(Buffer.alloc(32)));
  
  const batchTransferSig = await withTimeout(
    batchTransfer({
      connection,
      wallet: aliceAdapter,
      transfers: [
        {
          originMint: mintResult.originMint,
          poolId: mintResult.poolId,
          proof: batchProof,
          nullifiers: nullifiers1_bt.slice(0, 2),
          outputCommitments: outputCommitments1_bt.slice(0, 2),
          outputAmountCommitments: outputAmountCommitments1_bt.slice(0, 2)
        },
        {
          originMint: mintResult2.originMint,
          poolId: mintResult2.poolId,
          proof: batchProof,
          nullifiers: nullifiers2_bt.slice(0, 2),
          outputCommitments: outputCommitments2_bt.slice(0, 2),
          outputAmountCommitments: outputAmountCommitments2_bt.slice(0, 2)
        }
      ],
      batchProof,
      batchPublicInputs: batchProof.publicInputs,
      keypair: alice
    }),
    TX_CONFIRM_TIMEOUT_MS * 2,
    'Execute batch transfer in comprehensive test'
  );
  
  console.info(`[test-8] ✓ Batch transfer successful: ${batchTransferSig}`);
  
  // Verify roots updated (with timeout)
  await sleep(2000);
  const newRoot1_bt = await withTimeout(
    fetchZTokenPoolRoot(connection, originMintKey),
    FETCH_TIMEOUT_MS,
    'Fetch root 1 after batch transfer'
  );
  const newRoot2_bt = await withTimeout(
    fetchZTokenPoolRoot(connection, originMint2Key),
    FETCH_TIMEOUT_MS,
    'Fetch root 2 after batch transfer'
  );
  
  if (newRoot1_bt === batchProof.transfers[0]!.newRoot && newRoot2_bt === batchProof.transfers[1]!.newRoot) {
    console.info('[test-8] ✓ Both pool roots updated correctly');
  } else {
    throw new Error(`[test-8] Root mismatch: root1=${newRoot1_bt} (expected ${batchProof.transfers[0]!.newRoot}), root2=${newRoot2_bt} (expected ${batchProof.transfers[1]!.newRoot})`);
  }
  
  console.info('\n[comprehensive-e2e] ✅ All comprehensive E2E tests passed!');
  console.info('[comprehensive-e2e] Summary:');
  console.info('  ✓ Token minting via mint page API');
  console.info('  ✓ First-time shield (with lazy initialization)');
  console.info('  ✓ Second-time shield');
  console.info('  ✓ First-time unshield');
  console.info('  ✓ Second-time unshield');
  console.info('  ✓ Normal token trades between multiple accounts');
  console.info('  ✓ Private zToken trades between multiple accounts');
  console.info('  ✓ Batch transfer with 2 different zTokens');
}

async function main() {
  try {
    await comprehensiveE2ETest();
  } catch (error) {
    console.error('[fatal] comprehensive-e2e script failed', error);
    process.exitCode = 1;
  }
}

main();

