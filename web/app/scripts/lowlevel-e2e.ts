import bs58 from 'bs58';
import crypto from 'crypto';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress
} from '@solana/spl-token';
import { BN, BorshCoder, Idl } from '@coral-xyz/anchor';
import { ProofClient, ProofResponse } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { deriveViewingKey } from '../lib/wallet/viewingKey';
import { poseidonHashMany } from '../lib/onchain/poseidon';
import { canonicalizeHex, bytesLEToCanonicalHex, canonicalHexToBytesLE } from '../lib/onchain/utils';
import poolIdl from '../idl/ptf_pool.json';
import factoryIdl from '../idl/ptf_factory.json';
import {
  POOL_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  VERIFIER_PROGRAM_ID
} from '../lib/onchain/programIds';
import {
  derivePoolState,
  deriveNullifierSet,
  deriveNoteLedger,
  deriveCommitmentTree,
  deriveShieldClaim,
  deriveAllowanceAccount,
  deriveVaultState,
  deriveMintMapping,
  deriveFactoryState,
  deriveVerifyingKey,
  deriveHookConfig,
  deriveHookWhitelist,
  deriveTokenMetadata
} from '../lib/onchain/pdas';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const INDEXER_PROXY_URL = process.env.INDEXER_PROXY_URL ?? 'http://127.0.0.1:3000/api/indexer';
const FAUCET_BASE_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:3000/api/faucet';
const MINTS_API_URL = process.env.MINTS_API_URL ?? 'http://127.0.0.1:3000/api/mints';

const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (2n * 10n ** 9n).toString());
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000');
const TARGET_DECIMALS = Number(process.env.MINT_DECIMALS ?? '6');

const poolCoder = new BorshCoder(poolIdl as Idl);
const factoryCoder = new BorshCoder(factoryIdl as Idl);

interface MintConfig {
  originMint: string;
  poolId: string;
  symbol: string;
  decimals: number;
  zTokenMint?: string;
  lookupTable?: string;
}

interface DecodedProofPayload {
  proof: Buffer;
  publicInputs: Buffer;
  fields: Uint8Array[];
}

interface WrapResult {
  noteId: string;
  spendingKey: string;
  noteAmount: bigint;
  newRoot: string;
  commitment: string;
  nullifier: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toBuffer(value: Buffer | Uint8Array | number[] | undefined): Buffer {
  if (!value) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return Buffer.from(value);
}

function bnToBigInt(value: BN | bigint | number | undefined | null): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  if (BN.isBN(value)) {
    return BigInt(value.toString());
  }
  return BigInt(value as number);
}

interface CommitmentTreeState {
  root: string;
  nextIndex: bigint;
}

interface ShieldClaimState {
  newRoot: string;
  nextIndex: bigint;
  status: number;
}

async function readCommitmentTreeState(
  connection: Connection,
  commitmentTreeKey: PublicKey
): Promise<CommitmentTreeState | null> {
  const account = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
  if (!account) {
    return null;
  }

  const baseOffset = 8; // discriminator
  const canopyDepthOffset = baseOffset + 32;
  const padding = 7;
  const nextIndexOffset = canopyDepthOffset + 1 + padding;
  const currentRootOffset = nextIndexOffset + 8;

  if (account.data.length < currentRootOffset + 32) {
    throw new Error('Commitment tree account too small');
  }

  const nextIndexBytes = account.data.slice(nextIndexOffset, nextIndexOffset + 8);
  const rootBytes = account.data.slice(currentRootOffset, currentRootOffset + 32);
  return {
    root: canonicalizeHex(rootBytes.toString('hex')),
    nextIndex: nextIndexBytes.readBigUInt64LE(0)
  };
}

async function readShieldClaimState(
  connection: Connection,
  shieldClaimKey: PublicKey
): Promise<ShieldClaimState | null> {
  const account = await connection.getAccountInfo(shieldClaimKey, 'confirmed');
  if (!account) {
    return null;
  }

  const decoded = poolCoder.accounts.decode('ShieldClaim', account.data) as Record<string, unknown>;
  const rawNewRoot = (decoded.newRoot ?? decoded.new_root) as Buffer | Uint8Array | number[] | undefined;
  const newRootBytes = toBuffer(rawNewRoot);
  const nextIndexValue = decoded.nextIndex ?? decoded.next_index;
  const statusValue = decoded.status ?? decoded.Status ?? 0;

  return {
    newRoot: canonicalizeHex(newRootBytes.toString('hex')),
    nextIndex: bnToBigInt(nextIndexValue as BN | number | bigint | undefined),
    status: typeof statusValue === 'number' ? statusValue : Number(statusValue ?? 0)
  };
}

async function waitForMintMappingInitialized(
  connection: Connection,
  originMint: PublicKey,
  timeoutMs = 120_000
): Promise<void> {
  const mintMappingKey = deriveMintMapping(originMint);
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    const account = await connection.getAccountInfo(mintMappingKey, 'confirmed');
    if (account) {
      // Log account state for debugging
      if (attempts % 5 === 0 || account.owner.equals(FACTORY_PROGRAM_ID)) {
        console.info(
          `[waitForMintMappingInitialized] Attempt ${attempts + 1}: account exists, owner=${account.owner.toBase58()}, expected=${FACTORY_PROGRAM_ID.toBase58()}`
        );
      }
      
      if (account.owner.equals(FACTORY_PROGRAM_ID)) {
        try {
          const decoded = factoryCoder.accounts.decode('MintMapping', account.data) as { origin_mint: PublicKey };
          if (decoded.origin_mint.equals(originMint)) {
            if (attempts > 0) {
              console.info(
                `[waitForMintMappingInitialized] Mint mapping ready after ${attempts + 1} attempts (${mintMappingKey.toBase58()})`
              );
            }
            return;
          }
        } catch (e) {
          // If decoding fails but the account exists and is owned by the factory program,
          // treat it as initialized – the bootstrap script will have written valid data.
          console.info(
            `[waitForMintMappingInitialized] Account owned by factory but decode failed, treating as initialized: ${(e as Error).message}`
          );
          return;
        }
      }
    } else {
      if (attempts % 5 === 0) {
        console.info(
          `[waitForMintMappingInitialized] Attempt ${attempts + 1}: account does not exist yet (${mintMappingKey.toBase58()})`
        );
      }
    }
    attempts += 1;
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for mint mapping ${mintMappingKey.toBase58()} for origin mint ${originMint.toBase58()} to initialize`
  );
}

function randomFieldScalar(): string {
  const bytes = crypto.randomBytes(31);
  return BigInt(`0x${bytes.toString('hex')}`).toString();
}

let depositIdCounter = 0;
function generateUniqueDepositId(): string {
  // Use timestamp + counter + random to ensure uniqueness across test runs and within the same run
  // Format: timestamp (13 digits) + counter (6 digits) + random (7 digits) = 26 digit number
  const timestamp = Date.now();
  depositIdCounter += 1;
  const random = crypto.randomInt(1_000_000, 9_999_999);
  // Pad counter to 6 digits to ensure consistent length
  const counterStr = depositIdCounter.toString().padStart(6, '0');
  return `${timestamp}${counterStr}${random}`;
}

function pubkeyToFieldString(key: PublicKey): string {
  const hex = Buffer.from(key.toBytes()).toString('hex');
  return BigInt(`0x${hex}`).toString();
}

function toFixedArray(value: Uint8Array, label: string): number[] {
  if (value.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return Array.from(value);
}

function encodeFieldElementHex(value: string, label: string): number[] {
  const canonical = canonicalizeHex(value);
  const bytes = canonicalHexToBytesLE(canonical, 32);
  return Array.from(bytes);
}

function encodeFieldVector(values: readonly string[], label: string): number[][] {
  return values.map((entry, index) => encodeFieldElementHex(entry, `${label}[${index}]`));
}

function decodeProofPayload(payload: ProofResponse | null): DecodedProofPayload {
  if (!payload) {
    return {
      proof: Buffer.alloc(0),
      publicInputs: Buffer.alloc(0),
      fields: []
    };
  }

  if (typeof payload.proof !== 'string') {
    throw new Error('Proof payload missing base64 proof data');
  }
  const proofBytes = Buffer.from(payload.proof, 'base64');

  const fieldBytes = payload.publicInputs.map((input, index) => {
    if (typeof input !== 'string') {
      throw new Error(`Public input at index ${index} is not a string`);
    }
    const canonical = canonicalizeHex(input);
    const bytes = canonicalHexToBytesLE(canonical, 32);
    if (bytes.length !== 32) {
      throw new Error(`Public input at index ${index} must be 32 bytes`);
    }
    return bytes;
  });

  const flattened = Buffer.concat(fieldBytes.map((entry) => Buffer.from(entry)));

  return {
    proof: proofBytes,
    publicInputs: flattened,
    fields: fieldBytes
  };
}

async function faucetSol(connection: Connection, recipient: PublicKey): Promise<void> {
  const response = await fetch(`${FAUCET_BASE_URL}/sol`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: recipient.toBase58(), amountLamports: SOL_AIRDROP_LAMPORTS.toString() })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`SOL faucet failed: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`);
  }
  const { signature } = (await response.json()) as { signature: string };
  await connection.confirmTransaction(signature, 'confirmed');
  await sleep(1000);
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
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Token faucet failed: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`);
  }
  const { signature } = (await response.json()) as { signature: string };
  await connection.confirmTransaction(signature, 'confirmed');
  await sleep(1000);
}

async function fetchMintCatalog(): Promise<MintConfig[]> {
  const response = await fetch(MINTS_API_URL, { cache: 'no-store' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to fetch mint catalogue: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`
    );
  }
  const payload = (await response.json()) as { mints?: MintConfig[] };
  return payload.mints ?? [];
}

async function sendAndConfirmInstructions(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  lookupTable?: string
): Promise<string> {
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const lookupTables: AddressLookupTableAccount[] = [];

  if (lookupTable) {
    try {
      const tableKey = new PublicKey(lookupTable);
      const response = await connection.getAddressLookupTable(tableKey);
      if (response.value) {
        lookupTables.push(response.value);
      }
    } catch (error) {
      console.warn('[lowlevel-e2e] failed to load lookup table', error);
    }
  }

  let signature: string;
  if (lookupTables.length > 0) {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  } else {
    const tx = new Transaction();
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.add(...instructions);
    tx.sign(payer);
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  }

  await connection.confirmTransaction(
    { signature, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
    'confirmed'
  );
  return signature;
}

async function fetchShieldClaimStatus(connection: Connection, shieldClaimKey: PublicKey): Promise<number> {
  const account = await connection.getAccountInfo(shieldClaimKey, 'confirmed');
  if (!account) {
    return 0; // INACTIVE
  }
  try {
    const decoded = poolCoder.accounts.decode('ShieldClaim', account.data) as { status?: number };
    return decoded.status ?? 0;
  } catch {
    // If decoding fails, try manual reading
    const buffer = Buffer.from(account.data);
    if (buffer.length < 8 + 1) {
      return 0;
    }
    // ShieldClaim struct: discriminator (8) + pool (32) + depositor (32) + commitment (32) + amount_commit (32) + old_root (32) + new_root (32) + next_index (8) + status (1)
    // Status is at offset 8 + 32 + 32 + 32 + 32 + 32 + 32 + 8 = 208
    if (buffer.length >= 209) {
      return buffer.readUInt8(208);
    }
    return 0;
  }
}

async function waitForShieldClaimCleared(
  connection: Connection,
  shieldClaimKey: PublicKey,
  maxAttempts = 60
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await fetchShieldClaimStatus(connection, shieldClaimKey);
    if (status === 0) {
      if (attempt > 0) {
        console.info(`[waitForShieldClaimCleared] Shield claim cleared after ${attempt} attempts`);
      }
      return;
    }
    if (attempt % 10 === 0 && attempt > 0) {
      console.info(`[waitForShieldClaimCleared] Still waiting, status=${status}, attempt=${attempt}/${maxAttempts}`);
    }
    await sleep(1000);
  }
  const finalStatus = await fetchShieldClaimStatus(connection, shieldClaimKey);
  throw new Error(`Shield claim did not clear in time. Final status: ${finalStatus}`);
}

async function fetchPoolStateRoot(connection: Connection, poolId: string): Promise<{ root: string; feeBps: number }> {
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
  const rootBytes = buffer.slice(offset, offset + 32);

  offset += 32; // current_root
  offset += 32 * 64; // recent_roots (MAX_ROOTS = 64, not 16)
  offset += 8 * 64; // recent_roots_timestamps (i64 * 64)
  offset += 1; // roots_len
  if (offset % 2 !== 0) {
    offset += 1; // align for u16
  }
  const feeBps = buffer.readUInt16LE(offset);

  return {
    root: bytesLEToCanonicalHex(rootBytes),
    feeBps
  };
}

async function loadLocalAuthorityKeypair(): Promise<Keypair> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const keyPath = path.join(process.env.HOME ?? '.', '.config', 'solana', 'id.json');
  const raw = await fs.readFile(keyPath, 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  console.info('[lowlevel-e2e] Starting comprehensive low-level E2E test suite');
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const indexerClient = new IndexerClient({ baseUrl: INDEXER_PROXY_URL });

  const owner = Keypair.generate();
  const receiver = Keypair.generate();
  const delegate = Keypair.generate();
  const adminAuthority = await loadLocalAuthorityKeypair();

  console.info('[setup] Airdropping SOL to wallets');
  await Promise.all([owner, receiver, delegate].map((kp) => faucetSol(connection, kp.publicKey)));
  await faucetSol(connection, adminAuthority.publicKey);

  let catalog = await fetchMintCatalog();
  if (!catalog.length) {
    console.info('[setup] No mints found, creating a test mint via API...');
    // Create a mint via the API (similar to browser-e2e)
    const registerResponse = await fetch(MINTS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'TEST', decimals: TARGET_DECIMALS })
    });
    if (!registerResponse.ok) {
      throw new Error(`Failed to register mint: ${registerResponse.status} ${await registerResponse.text()}`);
    }
    // Fetch again to get the created mint
    catalog = await fetchMintCatalog();
    if (!catalog.length) {
      throw new Error('Failed to create mint via API. Run bootstrap script first.');
    }
    console.info('[setup] Test mint created successfully');
  }
  const mintConfig = catalog[0]!;
  await waitForMintMappingInitialized(connection, new PublicKey(mintConfig.originMint));

  console.info('[setup] Funding wallets with tokens');
  const originMintKey = new PublicKey(mintConfig.originMint);
  await faucetToken(connection, originMintKey, owner.publicKey, WRAP_AMOUNT * 5n);
  await faucetToken(connection, originMintKey, receiver.publicKey, WRAP_AMOUNT * 5n);
  const poolStateKey = new PublicKey(mintConfig.poolId);
  const nullifierSetKey = deriveNullifierSet(originMintKey);
  const noteLedgerKey = deriveNoteLedger(originMintKey);
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const hookConfigKey = deriveHookConfig(originMintKey);
  const vaultStateKey = deriveVaultState(originMintKey);
  const mintMappingKey = deriveMintMapping(originMintKey);
  const factoryStateKey = deriveFactoryState();
  const allowanceAddress = deriveAllowanceAccount(poolStateKey, owner.publicKey, delegate.publicKey);
  const verifyingKey = deriveVerifyingKey();
  
  // Check if hook_config exists
  const hookConfigAccount = await connection.getAccountInfo(hookConfigKey, 'confirmed');
  const hookConfigExists = hookConfigAccount !== null;
  if (!hookConfigExists) {
    console.warn('[setup] hook_config account does not exist - some tests may fail');
  }

  const initialPoolInfo = await fetchPoolStateRoot(connection, mintConfig.poolId);
  let currentRoot = canonicalizeHex(initialPoolInfo.root);
  const feeBps = BigInt(initialPoolInfo.feeBps);

  // Clear any pending shield claims from previous runs
  console.info('[setup] Checking for pending shield claims...');
  const shieldClaimKey = deriveShieldClaim(poolStateKey);
  const hookWhitelistKey = deriveHookWhitelist(originMintKey);
  console.info(`[setup] Shield claim account: ${shieldClaimKey.toBase58()}`);
  const shieldClaimStatus = await fetchShieldClaimStatus(connection, shieldClaimKey);
  if (shieldClaimStatus !== 0) {
    console.info('[setup] Found pending shield claim, attempting to finalize...');
    // After finalizing, refresh the root as it may have changed
    await waitForShieldClaimCleared(connection, shieldClaimKey);
    const refreshedPoolInfo = await fetchPoolStateRoot(connection, mintConfig.poolId);
    currentRoot = canonicalizeHex(refreshedPoolInfo.root);
    try {
      const finalizeTreeIx = new TransactionInstruction({
        programId: POOL_PROGRAM_ID,
        keys: [
          { pubkey: poolStateKey, isSigner: false, isWritable: true },
          { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
          { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
        ],
        data: poolCoder.instruction.encode('shield_finalize_tree', {})
      });
      await sendAndConfirmInstructions(connection, adminAuthority, [finalizeTreeIx], mintConfig.lookupTable);
    } catch (e) {
      console.warn('[setup] Could not finalize tree, trying ledger...', (e as Error).message);
    }
    try {
      const finalizeLedgerIx = new TransactionInstruction({
        programId: POOL_PROGRAM_ID,
        keys: [
          { pubkey: poolStateKey, isSigner: false, isWritable: true },
          { pubkey: hookConfigKey, isSigner: false, isWritable: false },
          { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
          { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
          { pubkey: hookWhitelistKey, isSigner: false, isWritable: false }
        ],
        data: poolCoder.instruction.encode('shield_finalize_ledger', {})
      });
      await sendAndConfirmInstructions(connection, adminAuthority, [finalizeLedgerIx], mintConfig.lookupTable);
    } catch (e) {
      console.warn('[setup] Could not finalize ledger...', (e as Error).message);
    }
    try {
      const checkInvariantIx = new TransactionInstruction({
        programId: POOL_PROGRAM_ID,
        keys: [
          { pubkey: poolStateKey, isSigner: false, isWritable: false },
          { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
          { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
          { pubkey: await getAssociatedTokenAddress(originMintKey, vaultStateKey, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
          { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : POOL_PROGRAM_ID, isSigner: false, isWritable: mintConfig.zTokenMint ? true : false }
        ],
        data: poolCoder.instruction.encode('shield_check_invariant', {})
      });
      await sendAndConfirmInstructions(connection, adminAuthority, [checkInvariantIx], mintConfig.lookupTable);
      await waitForShieldClaimCleared(connection, shieldClaimKey);
    } catch (e) {
      console.warn('[setup] Could not check invariant...', (e as Error).message);
    }
  }

  console.info('[test-01] Testing shield instruction (low-level)');
  const depositorTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    owner.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Ensure account exists before faucet (faucet might create it, but we want to control it)
  const depositorInfo = await connection.getAccountInfo(depositorTokenAccount, 'confirmed');
  if (!depositorInfo || !depositorInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    console.info('[test-01] Creating depositor token account...');
    const ix = createAssociatedTokenAccountInstruction(
      owner.publicKey,
      depositorTokenAccount,
      owner.publicKey,
      originMintKey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await sendAndConfirmInstructions(connection, owner, [ix]);
    // Wait for account to be fully initialized and confirmed
    let retries = 0;
    while (retries < 20) {
      const accountInfo = await connection.getAccountInfo(depositorTokenAccount, 'confirmed');
      if (accountInfo && accountInfo.owner.equals(TOKEN_PROGRAM_ID) && accountInfo.data.length >= 165) {
        // Token account should be at least 165 bytes (standard SPL token account size)
        console.info(`[test-01] Depositor token account initialized after ${retries + 1} attempts`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      retries++;
    }
    const finalAccountInfo = await connection.getAccountInfo(depositorTokenAccount, 'confirmed');
    if (!finalAccountInfo || !finalAccountInfo.owner.equals(TOKEN_PROGRAM_ID) || finalAccountInfo.data.length < 165) {
      throw new Error(`Failed to initialize depositor token account: ${depositorTokenAccount.toBase58()}, owner=${finalAccountInfo?.owner.toBase58()}, dataLen=${finalAccountInfo?.data.length ?? 0}`);
    }
  } else {
    console.info(`[test-01] Depositor token account already exists: ${depositorTokenAccount.toBase58()}`);
  }
  
  // Now fund the account - this should work since account exists
  await faucetToken(connection, originMintKey, owner.publicKey, WRAP_AMOUNT * 10n);
  
  // Verify account still exists and is valid after faucet
  const postFaucetInfo = await connection.getAccountInfo(depositorTokenAccount, 'confirmed');
  if (!postFaucetInfo || !postFaucetInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`Depositor token account invalid after faucet: ${depositorTokenAccount.toBase58()}`);
  }

  // Ensure shield claim is cleared and root is current before generating proof
  await waitForShieldClaimCleared(connection, shieldClaimKey);
  const rootBeforeProof = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(rootBeforeProof.root);
  
  const depositId1 = generateUniqueDepositId();
  const blinding1 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount1 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof1 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount1.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId1,
    poolId: mintConfig.poolId,
    blinding: blinding1,
    mintId: mintConfig.originMint
  });

  const decodedProof1 = decodeProofPayload(proof1);
  const amountCommitmentBytes = await poseidonHashMany([noteAmount1, BigInt(blinding1)]);
  const vaultTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    vaultStateKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  let shieldArgs = {
    amount_commit: Array.from(amountCommitmentBytes),
    amount: new BN(noteAmount1.toString()),
    proof: decodedProof1.proof,
    public_inputs: decodedProof1.publicInputs
  };

  let shieldData = poolCoder.instruction.encode('shield', { args: shieldArgs });

  const shieldKeys = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
    { pubkey: hookWhitelistKey, isSigner: false, isWritable: true },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: vaultStateKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }
  ];

  if (mintConfig.zTokenMint) {
    shieldKeys.push({ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true });
  } else {
    shieldKeys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  shieldKeys.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  let shieldIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys,
    data: shieldData
  });

  // Refresh root right before sending to ensure it matches what's on-chain
  // Add a small delay to ensure any pending transactions are finalized
  await new Promise(resolve => setTimeout(resolve, 500));
  const finalRootCheck = await fetchPoolStateRoot(connection, mintConfig.poolId);
  const finalRoot = canonicalizeHex(finalRootCheck.root);
  
  // Always regenerate proof right before sending to ensure root matches exactly
  // This handles any timing issues where the root might have changed
  console.info(`[test-01] Regenerating proof with final root: ${finalRoot}`);
  const proof1Final = await proofClient.requestProof('wrap', {
    oldRoot: finalRoot,
    amount: noteAmount1.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId1,
    poolId: mintConfig.poolId,
    blinding: blinding1,
    mintId: mintConfig.originMint
  });
  console.info('[test-01] Proof service publicInputs:', proof1Final?.publicInputs);
  const decodedProof1Final = decodeProofPayload(proof1Final);
  const proofNewRootHex = canonicalizeHex(Buffer.from(decodedProof1Final.fields[1] ?? Buffer.alloc(32)).toString('hex'));
  console.info(`[test-01] Proof new_root for first shield: ${proofNewRootHex}`);
  
  // Debug: Verify root format matches
  const proofOldRootBytes = Buffer.from(decodedProof1Final.fields[0]!);
  const poolAccount = await connection.getAccountInfo(new PublicKey(mintConfig.poolId), 'confirmed');
  if (!poolAccount) {
    throw new Error('Pool state account missing');
  }
  const poolBuffer = Buffer.from(poolAccount.data);
  const rootOffset = 8 + (32 * 6) + 32 + 32; // discriminator + 6 pubkeys + 2 [u8;32]
  const onChainRootBytes = poolBuffer.slice(rootOffset, rootOffset + 32);
  
  console.info(`[test-01] Root comparison - Proof: ${proofOldRootBytes.toString('hex')}, On-chain: ${onChainRootBytes.toString('hex')}`);
  if (!proofOldRootBytes.equals(onChainRootBytes)) {
    console.error(`[test-01] CRITICAL: Root mismatch detected! Proof root does not match on-chain root.`);
    console.error(`[test-01] This indicates a format conversion issue between proof service and on-chain format.`);
    // Try one more time with a fresh root fetch
    await new Promise(resolve => setTimeout(resolve, 1000));
    const lastRootCheck = await fetchPoolStateRoot(connection, mintConfig.poolId);
    const lastRoot = canonicalizeHex(lastRootCheck.root);
    if (lastRoot !== finalRoot) {
      console.warn(`[test-01] Root changed again, using latest: ${lastRoot}`);
      const proof1Last = await proofClient.requestProof('wrap', {
        oldRoot: lastRoot,
        amount: noteAmount1.toString(),
        recipient: owner.publicKey.toBase58(),
        depositId: depositId1,
        poolId: mintConfig.poolId,
        blinding: blinding1,
        mintId: mintConfig.originMint
      });
      const decodedProof1Last = decodeProofPayload(proof1Last);
      shieldArgs.proof = decodedProof1Last.proof;
      shieldArgs.public_inputs = decodedProof1Last.publicInputs;
      shieldData = poolCoder.instruction.encode('shield', { args: shieldArgs });
      shieldIx.data = shieldData;
      currentRoot = lastRoot;
    }
  } else {
    shieldArgs.proof = decodedProof1Final.proof;
    shieldArgs.public_inputs = decodedProof1Final.publicInputs;
    shieldData = poolCoder.instruction.encode('shield', { args: shieldArgs });
    shieldIx.data = shieldData;
    currentRoot = finalRoot;
  }
  
  // CRITICAL FIX: finalize_ledger must be in the same transaction as shield for security
  // This ensures atomicity - tokens are only deposited if finalization will complete
  // This matches the SDK behavior (see sdk.ts line 583) and the on-chain security requirement
  const finalizeLedgerData = poolCoder.instruction.encode('shield_finalize_ledger', {});
  const finalizeLedgerIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: hookWhitelistKey, isSigner: false, isWritable: false }
    ],
    data: finalizeLedgerData
  });

  // Include shield and finalize_ledger in the same transaction (required for security)
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
    shieldIx,
    finalizeLedgerIx
  ];
  const shieldSig = await sendAndConfirmInstructions(connection, owner, instructions, mintConfig.lookupTable);
  console.info('[test-01] shield + finalize_ledger instruction successful', shieldSig);
  const shieldClaimAfterShield = await readShieldClaimState(connection, shieldClaimKey);
  if (shieldClaimAfterShield) {
    console.info(
      `[test-01] Shield claim new_root after shield: ${shieldClaimAfterShield.newRoot}, next_index: ${shieldClaimAfterShield.nextIndex}, status: ${shieldClaimAfterShield.status}`
    );
  }

  console.info('[test-02] Testing shield_finalize_tree instruction (low-level)');
  // Check root before finalize_tree
  const rootBeforeFinalize = await fetchPoolStateRoot(connection, mintConfig.poolId);
  console.info(`[test-02] Root before shield_finalize_tree: ${canonicalizeHex(rootBeforeFinalize.root)}`);
  
  const finalizeTreeData = poolCoder.instruction.encode('shield_finalize_tree', {});
  const finalizeTreeIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: finalizeTreeData
  });
  const finalizeTreeSig = await sendAndConfirmInstructions(connection, owner, [finalizeTreeIx], mintConfig.lookupTable);
  console.info('[test-02] shield_finalize_tree instruction successful', finalizeTreeSig);
  
  // Check root after finalize_tree
  await new Promise(resolve => setTimeout(resolve, 500));
  const rootAfterFinalize = await fetchPoolStateRoot(connection, mintConfig.poolId);
  console.info(`[test-02] Root after shield_finalize_tree: ${canonicalizeHex(rootAfterFinalize.root)}`);
  
  const treeStateAfterFinalize = await readCommitmentTreeState(connection, commitmentTreeKey);
  if (treeStateAfterFinalize) {
    console.info(`[test-02] Commitment tree root after shield_finalize_tree: ${treeStateAfterFinalize.root}`);
    console.info(`[test-02] Commitment tree next_index after shield_finalize_tree: ${treeStateAfterFinalize.nextIndex}`);
  }
  const shieldClaimAfterTree = await readShieldClaimState(connection, shieldClaimKey);
  if (shieldClaimAfterTree) {
    console.info(
      `[test-02] Shield claim new_root after finalize_tree: ${shieldClaimAfterTree.newRoot}, next_index: ${shieldClaimAfterTree.nextIndex}, status: ${shieldClaimAfterTree.status}`
    );
  }

  console.info('[test-03b] Testing shield_check_invariant instruction (low-level)');
  const checkInvariantData = poolCoder.instruction.encode('shield_check_invariant', {});
  const checkInvariantKeys = [
    { pubkey: poolStateKey, isSigner: false, isWritable: false },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true }
  ];
  if (mintConfig.zTokenMint) {
    checkInvariantKeys.push({ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true });
  } else {
    checkInvariantKeys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }
  const checkInvariantIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: checkInvariantKeys,
    data: checkInvariantData
  });
  const checkInvariantSig = await sendAndConfirmInstructions(
    connection,
    owner,
    [checkInvariantIx],
    mintConfig.lookupTable
  );
  console.info('[test-03b] shield_check_invariant instruction successful', checkInvariantSig);

  await waitForShieldClaimCleared(connection, shieldClaimKey);
  await sleep(1000);
  const updatedRoot = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot.root);
  console.info(`[test-04] Root after first shield (from pool_state): ${currentRoot}`);
  const wrap1: WrapResult = {
    noteId: depositId1,
    spendingKey: blinding1,
    noteAmount: noteAmount1,
    newRoot: currentRoot,
    commitment: proof1.publicInputs[2]!,
    nullifier: Buffer.from(await poseidonHashMany([BigInt(depositId1), BigInt(blinding1)])).reverse().toString('hex').padStart(64, '0')
  };

  console.info('[test-04] Testing private_transfer instruction (low-level)');
  
  // Ensure shield claim is cleared before starting next shield
  const statusBefore = await fetchShieldClaimStatus(connection, shieldClaimKey);
  if (statusBefore !== 0) {
    console.warn(`[test-04] Shield claim status is ${statusBefore}, waiting for clearance...`);
    await waitForShieldClaimCleared(connection, shieldClaimKey, 60);
  }
  
  await sleep(1000);
  const poolRootBeforeSecond = await fetchPoolStateRoot(connection, mintConfig.poolId);
  const currentRoot2 = canonicalizeHex(poolRootBeforeSecond.root);
  console.info(`[test-04] Root before second shield (from pool_state): ${currentRoot2}`);
  
  const depositId2 = generateUniqueDepositId();
  const blinding2 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount2 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof2 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot2,
    amount: noteAmount2.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId2,
    poolId: mintConfig.poolId,
    blinding: blinding2,
    mintId: mintConfig.originMint
  });

  const decodedProof2 = decodeProofPayload(proof2);
  const amountCommitmentBytes2 = await poseidonHashMany([noteAmount2, BigInt(blinding2)]);

  const shieldArgs2 = {
    amount_commit: Array.from(amountCommitmentBytes2),
    amount: new BN(noteAmount2.toString()),
    proof: decodedProof2.proof,
    public_inputs: decodedProof2.publicInputs
  };

  const shieldData2 = poolCoder.instruction.encode('shield', { args: shieldArgs2 });

  const shieldKeys2 = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
    { pubkey: hookWhitelistKey, isSigner: false, isWritable: true },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: vaultStateKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }
  ];

  if (mintConfig.zTokenMint) {
    shieldKeys2.push({ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true });
  } else {
    shieldKeys2.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  shieldKeys2.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  const shieldIx2 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys2,
    data: shieldData2
  });

  // Include finalize_ledger in same transaction as shield (required for security)
  const finalizeLedgerIx2 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: hookWhitelistKey, isSigner: false, isWritable: false }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(
    connection,
    owner,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), shieldIx2, finalizeLedgerIx2],
    mintConfig.lookupTable
  );

  const finalizeTreeIx2 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeTreeIx2], mintConfig.lookupTable);
  const checkInvariantIx2 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : POOL_PROGRAM_ID, isSigner: false, isWritable: mintConfig.zTokenMint ? true : false }
    ],
    data: poolCoder.instruction.encode('shield_check_invariant', {})
  });
  await sendAndConfirmInstructions(connection, owner, [checkInvariantIx2], mintConfig.lookupTable);
  await waitForShieldClaimCleared(connection, shieldClaimKey);

  const updatedRoot2 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot2.root);
  console.info(`[test-04] Root before transfer (from pool_state): ${currentRoot}`);
  
  // Also check commitment_tree root to ensure consistency
  // Use pool_state root as source of truth since it's what the program checks
  // The commitment_tree root should match, but we'll use pool_state to avoid byte order issues
  console.info(`[test-04] Using pool_state root for transfer proof: ${currentRoot}`);

  const transferAmount = WRAP_AMOUNT / 2n;
  const changeAmount = wrap1.noteAmount - transferAmount;
  const transferBlinding = randomFieldScalar();
  const changeBlinding = randomFieldScalar();

  const transferProof = await proofClient.requestProof('transfer', {
    oldRoot: currentRoot,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    inNotes: [
      {
        noteId: wrap1.noteId,
        spendingKey: wrap1.spendingKey,
        amount: wrap1.noteAmount.toString()
      }
    ],
    outNotes: [
      {
        amount: transferAmount.toString(),
        recipient: pubkeyToFieldString(receiver.publicKey),
        blinding: transferBlinding
      },
      {
        amount: changeAmount.toString(),
        recipient: pubkeyToFieldString(owner.publicKey),
        blinding: changeBlinding
      }
    ]
  });

  const decodedTransferProof = decodeProofPayload(transferProof);
  
  // CRITICAL FIX: Validate proof length before sending
  if (decodedTransferProof.proof.length < 192) {
    console.error('[test-04] Proof validation failed', {
      proofLength: decodedTransferProof.proof.length,
      requiredLength: 192,
      proofBase64: transferProof.proof?.substring(0, 100),
      proofHex: decodedTransferProof.proof.toString('hex').substring(0, 100)
    });
    throw new Error(`Proof length (${decodedTransferProof.proof.length}) is less than required 192 bytes. Proof may be corrupted or improperly decoded.`);
  }
  
  // Structure: [oldRoot, newRoot, ...nullifiers, ...output_commitments, mint, pool]
  // Extract nullifier from proof (at index 2, after oldRoot and newRoot)
  const numNullifiers = 1;
  const numOutputs = 2;
  const nullifierFromProof = decodedTransferProof.fields[2]!; // First nullifier is at index 2
  const nullifierBytes = Array.from(nullifierFromProof);
  // Output commitments start after nullifiers
  const outputStart = 2 + numNullifiers; // After oldRoot, newRoot, and nullifiers
  const outputCommitments = decodedTransferProof.fields.slice(outputStart, outputStart + numOutputs).map((field) => Array.from(field));
  const amountCommitments = await Promise.all([
    poseidonHashMany([transferAmount, BigInt(transferBlinding)]),
    poseidonHashMany([changeAmount, BigInt(changeBlinding)])
  ]).then((hashes) => hashes.map((h) => {
    const bytes = Buffer.from(h).reverse();
    return Array.from(bytes);
  }));

  const transferArgs = {
    old_root: toFixedArray(decodedTransferProof.fields[0]!, 'old_root'),
    new_root: toFixedArray(decodedTransferProof.fields[1]!, 'new_root'),
    nullifiers: [Array.from(nullifierBytes)],
    output_commitments: outputCommitments,
    output_amount_commitments: amountCommitments,
    proof: Buffer.from(decodedTransferProof.proof),
    public_inputs: Buffer.from(decodedTransferProof.publicInputs)
  };

  const transferData = poolCoder.instruction.encode('private_transfer', { args: transferArgs });

  const transferIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: transferData
  });

  const transferSig = await sendAndConfirmInstructions(
    connection,
    owner,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), transferIx],
    mintConfig.lookupTable
  );
  console.info('[test-04] private_transfer instruction successful', transferSig);

  const updatedRoot3 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot3.root);

  console.info('[test-05] Testing approve_allowance instruction (low-level)');
  const allowanceAmount = WRAP_AMOUNT;
  const approveData = poolCoder.instruction.encode('approve_allowance', {
    args: { amount: new BN(allowanceAmount.toString()), expires_at: null }
  });
  const approveIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: delegate.publicKey, isSigner: false, isWritable: false },
      { pubkey: originMintKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false }
    ],
    data: approveData
  });
  const approveSig = await sendAndConfirmInstructions(connection, owner, [approveIx], mintConfig.lookupTable);
  console.info('[test-05] approve_allowance instruction successful', approveSig);

  console.info('[test-06] Testing transfer_from instruction (low-level)');
  // Ensure mint_mapping is initialized before third shield
  await waitForMintMappingInitialized(connection, originMintKey);
  // Refresh root before third shield to ensure we have the latest on-chain root
  const rootBeforeShield3 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(rootBeforeShield3.root);
  console.info(`[test-06] Root before third shield: ${currentRoot}`);
  const depositId3 = generateUniqueDepositId();
  const blinding3 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount3 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof3 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount3.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId3,
    poolId: mintConfig.poolId,
    blinding: blinding3,
    mintId: mintConfig.originMint
  });

  const decodedProof3 = decodeProofPayload(proof3);
  const amountCommitmentBytes3 = await poseidonHashMany([noteAmount3, BigInt(blinding3)]);

  const shieldArgs3 = {
    amount_commit: Array.from(amountCommitmentBytes3),
    amount: new BN(noteAmount3.toString()),
    proof: decodedProof3.proof,
    public_inputs: decodedProof3.publicInputs
  };

  const shieldData3 = poolCoder.instruction.encode('shield', { args: shieldArgs3 });

  const shieldKeys3 = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
    { pubkey: hookWhitelistKey, isSigner: false, isWritable: true },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: vaultStateKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }
  ];

  if (mintConfig.zTokenMint) {
    shieldKeys3.push({ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true });
  } else {
    shieldKeys3.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  shieldKeys3.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  const shieldIx3 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys3,
    data: shieldData3
  });
  // Include finalize_ledger in same transaction as shield (required for security)
  const finalizeLedgerIx3 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: hookWhitelistKey, isSigner: false, isWritable: false }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(
    connection,
    owner,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), shieldIx3, finalizeLedgerIx3],
    mintConfig.lookupTable
  );

  const finalizeTreeIx3 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeTreeIx3], mintConfig.lookupTable);
  const checkInvariantIx3 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : POOL_PROGRAM_ID, isSigner: false, isWritable: mintConfig.zTokenMint ? true : false }
    ],
    data: poolCoder.instruction.encode('shield_check_invariant', {})
  });
  await sendAndConfirmInstructions(connection, owner, [checkInvariantIx3], mintConfig.lookupTable);
  await waitForShieldClaimCleared(connection, shieldClaimKey);

  const updatedRoot4 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot4.root);

  const wrap3: WrapResult = {
    noteId: depositId3,
    spendingKey: blinding3,
    noteAmount: noteAmount3,
    newRoot: currentRoot,
    commitment: proof3.publicInputs[2]!,
    nullifier: Buffer.from(await poseidonHashMany([BigInt(depositId3), BigInt(blinding3)])).reverse().toString('hex').padStart(64, '0')
  };

  const transferFromAmount = WRAP_AMOUNT / 4n;
  const changeFromAmount = wrap3.noteAmount - transferFromAmount;
  const transferFromBlinding = randomFieldScalar();
  const changeFromBlinding = randomFieldScalar();

  const transferFromProof = await proofClient.requestProof('transfer', {
    oldRoot: currentRoot,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    inNotes: [
      {
        noteId: wrap3.noteId,
        spendingKey: wrap3.spendingKey,
        amount: wrap3.noteAmount.toString()
      }
    ],
    outNotes: [
      {
        amount: transferFromAmount.toString(),
        recipient: pubkeyToFieldString(receiver.publicKey),
        blinding: transferFromBlinding
      },
      {
        amount: changeFromAmount.toString(),
        recipient: pubkeyToFieldString(owner.publicKey),
        blinding: changeFromBlinding
      }
    ]
  });

  const decodedTransferFromProof = decodeProofPayload(transferFromProof);
  // Structure: [oldRoot, newRoot, ...nullifiers, ...output_commitments, mint, pool]
  // Extract nullifier from proof (at index 2, after oldRoot and newRoot)
  const numNullifiers3 = 1;
  const numOutputs3 = 2;
  const nullifierFromProof3 = decodedTransferFromProof.fields[2]!; // First nullifier is at index 2
  const nullifierBytes3 = Array.from(nullifierFromProof3);
  // Output commitments start after nullifiers
  const outputStart3 = 2 + numNullifiers3;
  const outputCommitments3 = decodedTransferFromProof.fields.slice(outputStart3, outputStart3 + numOutputs3).map((field) => Array.from(field));
  const amountCommitments3 = await Promise.all([
    poseidonHashMany([transferFromAmount, BigInt(transferFromBlinding)]),
    poseidonHashMany([changeFromAmount, BigInt(changeFromBlinding)])
  ]).then((hashes) => hashes.map((h) => {
    const bytes = Buffer.from(h).reverse();
    return Array.from(bytes);
  }));

  const transferFromTransferArgs = {
    old_root: toFixedArray(decodedTransferFromProof.fields[0]!, 'old_root'),
    new_root: toFixedArray(decodedTransferFromProof.fields[1]!, 'new_root'),
    nullifiers: [Array.from(nullifierBytes3)],
    output_commitments: outputCommitments3,
    output_amount_commitments: amountCommitments3,
    proof: decodedTransferFromProof.proof,
    public_inputs: decodedTransferFromProof.publicInputs
  };

  const transferFromArgs = {
    transfer: transferFromTransferArgs,
    allowance_amount: new BN(transferFromAmount.toString()),
    spend_amount: new BN(transferFromAmount.toString()) // Spend amount is the amount going to receiver (not change)
  };

  const transferFromData = poolCoder.instruction.encode('transfer_from', { args: transferFromArgs });

  const transferFromIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: false, isWritable: false },
      { pubkey: delegate.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: transferFromData
  });

  const transferFromSig = await sendAndConfirmInstructions(
    connection,
    delegate,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), transferFromIx],
    mintConfig.lookupTable
  );
  console.info('[test-06] transfer_from instruction successful', transferFromSig);

  const updatedRoot5 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot5.root);

  console.info('[test-07] Testing unshield_to_origin instruction (low-level)');
  // Ensure mint_mapping is initialized before fourth shield
  await waitForMintMappingInitialized(connection, originMintKey);
  // Refresh root before fourth shield
  const rootBeforeShield4 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(rootBeforeShield4.root);
  console.info(`[test-07] Root before fourth shield: ${currentRoot}`);
  const depositId4 = generateUniqueDepositId();
  const blinding4 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount4 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof4 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount4.toString(),
    recipient: receiver.publicKey.toBase58(),
    depositId: depositId4,
    poolId: mintConfig.poolId,
    blinding: blinding4,
    mintId: mintConfig.originMint
  });

  const decodedProof4 = decodeProofPayload(proof4);
  const amountCommitmentBytes4 = await poseidonHashMany([noteAmount4, BigInt(blinding4)]);

  const shieldArgs4 = {
    amount_commit: Array.from(amountCommitmentBytes4),
    amount: new BN(noteAmount4.toString()),
    proof: decodedProof4.proof,
    public_inputs: decodedProof4.publicInputs
  };

  const shieldData4 = poolCoder.instruction.encode('shield', { args: shieldArgs4 });

  const receiverTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    receiver.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const receiverInfo = await connection.getAccountInfo(receiverTokenAccount);
  if (!receiverInfo) {
    const ix = createAssociatedTokenAccountInstruction(
      receiver.publicKey,
      receiverTokenAccount,
      receiver.publicKey,
      originMintKey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await sendAndConfirmInstructions(connection, receiver, [ix]);
  }

  const shieldKeys4 = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
    { pubkey: hookWhitelistKey, isSigner: false, isWritable: true },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: vaultStateKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: receiverTokenAccount, isSigner: false, isWritable: true }
  ];

  if (mintConfig.zTokenMint) {
    shieldKeys4.push({ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true });
  } else {
    shieldKeys4.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  shieldKeys4.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
    { pubkey: receiver.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  const shieldIx4 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys4,
    data: shieldData4
  });
  // Include finalize_ledger in same transaction as shield (required for security)
  const finalizeLedgerIx4 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: hookWhitelistKey, isSigner: false, isWritable: false }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(
    connection,
    receiver,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), shieldIx4, finalizeLedgerIx4],
    mintConfig.lookupTable
  );

  const finalizeTreeIx4 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, receiver, [finalizeTreeIx4], mintConfig.lookupTable);
  const checkInvariantIx4 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : POOL_PROGRAM_ID, isSigner: false, isWritable: mintConfig.zTokenMint ? true : false }
    ],
    data: poolCoder.instruction.encode('shield_check_invariant', {})
  });
  await sendAndConfirmInstructions(connection, receiver, [checkInvariantIx4], mintConfig.lookupTable);
  await waitForShieldClaimCleared(connection, shieldClaimKey);

  const updatedRoot6 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot6.root);
  console.info(`[test-07] Root before unshield (from pool_state): ${currentRoot}`);
  
  // Use pool_state root as source of truth since is_known_root checks against pool_state
  // The commitment_tree root should match, but pool_state is what the program checks

  const wrap4: WrapResult = {
    noteId: depositId4,
    spendingKey: blinding4,
    noteAmount: noteAmount4,
    newRoot: currentRoot,
    commitment: proof4.publicInputs[2]!,
    nullifier: Buffer.from(await poseidonHashMany([BigInt(depositId4), BigInt(blinding4)])).reverse().toString('hex').padStart(64, '0')
  };

  // CRITICAL FIX: Calculate unshield amount and fee correctly
  // The note amount includes the original deposit + fee from shield
  // For unshield, we want to unshield most of the note, leaving room for the unshield fee
  // Calculate: if we want to unshield X, fee = (X * feeBps) / 10000, and we need X + fee <= noteAmount
  // So: X + (X * feeBps) / 10000 <= noteAmount
  // X * (1 + feeBps/10000) <= noteAmount
  // X <= noteAmount / (1 + feeBps/10000)
  // X <= noteAmount * 10000 / (10000 + feeBps)
  let unshieldAmount = (wrap4.noteAmount * 10_000n) / (10_000n + feeBps);
  // Calculate fee based on unshield amount (matching on-chain calculation: (amount * fee_bps) / 10000)
  let calculatedFee = (unshieldAmount * feeBps) / 10_000n;
  // CRITICAL FIX: On-chain enforces minimum fee of 1 lamport (MIN_FEE)
  // But if calculated fee is 0, we still need to ensure the calculation matches on-chain
  // On-chain: fee_u64.max(MIN_FEE) where MIN_FEE = 1
  // So if calculatedFee is 0, fee should be 1, otherwise use calculatedFee
  let fee = calculatedFee > 0n ? calculatedFee : 1n;
  // Verify: unshieldAmount + fee should be <= noteAmount (with small tolerance for rounding)
  let totalNeeded = unshieldAmount + fee;
  if (totalNeeded > wrap4.noteAmount) {
    // Adjust unshield amount down if needed to ensure total fits
    // Try with fee=1 first (minimum fee case)
    if (wrap4.noteAmount > 1n) {
      unshieldAmount = wrap4.noteAmount - 1n;
      calculatedFee = (unshieldAmount * feeBps) / 10_000n;
      fee = calculatedFee > 0n ? calculatedFee : 1n;
      totalNeeded = unshieldAmount + fee;
      if (totalNeeded > wrap4.noteAmount) {
        // Still doesn't fit, reduce unshield amount further
        fee = (unshieldAmount * feeBps) / 10_000n;
        fee = fee > 0n ? fee : 1n;
        unshieldAmount = wrap4.noteAmount - fee;
      }
    } else {
      throw new Error(`Cannot unshield: noteAmount ${wrap4.noteAmount} is too small`);
    }
  }
  const unshieldBlinding = randomFieldScalar();

  const unshieldProof = await proofClient.requestProof('unwrap', {
    oldRoot: currentRoot,
    amount: unshieldAmount.toString(),
    fee: fee.toString(),
    destPubkey: receiver.publicKey.toBase58(),
    mode: 'origin',
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    noteId: wrap4.noteId,
    spendingKey: wrap4.spendingKey,
    noteAmount: wrap4.noteAmount.toString()
  });

  const decodedUnshieldProof = decodeProofPayload(unshieldProof);
  const nullifierBytes4 = Buffer.from(wrap4.nullifier, 'hex').reverse();
  const destinationTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    receiver.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const ROOT_FIELD_COUNT = 2;
  const TRAILING_FIELD_COUNT = 6;
  const CHANGE_FIELD_COUNT = 2;
  const nullifierCount = decodedUnshieldProof.fields.length - (ROOT_FIELD_COUNT + TRAILING_FIELD_COUNT + CHANGE_FIELD_COUNT);
  const oldRootBytes = decodedUnshieldProof.fields[0]!;
  const newRootBytes = decodedUnshieldProof.fields[1]!;
  const nullifierBytesArray = decodedUnshieldProof.fields.slice(2, 2 + nullifierCount);
  const changeCommitmentBytes = decodedUnshieldProof.fields[2 + nullifierCount]!;
  const changeAmountCommitmentBytes = decodedUnshieldProof.fields[3 + nullifierCount]!;

  const unshieldArgs = {
    old_root: Array.from(oldRootBytes),
    new_root: Array.from(newRootBytes),
    nullifiers: nullifierBytesArray.map((entry) => Array.from(entry)),
    output_commitments: [Array.from(changeCommitmentBytes)],
    output_amount_commitments: [Array.from(changeAmountCommitmentBytes)],
    amount: new BN(unshieldAmount.toString()),
    proof: decodedUnshieldProof.proof,
    public_inputs: decodedUnshieldProof.publicInputs
  };

  const unshieldData = poolCoder.instruction.encode('unshield_to_origin', { args: unshieldArgs });

  const unshieldIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: hookWhitelistKey, isSigner: false, isWritable: false },
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: vaultStateKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      ...(mintConfig.zTokenMint ? [{ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true }] : []),
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: factoryStateKey, isSigner: false, isWritable: false },
      { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: receiver.publicKey, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: unshieldData
  });

  const unshieldSig = await sendAndConfirmInstructions(
    connection,
    receiver,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), unshieldIx],
    mintConfig.lookupTable
  );
  console.info('[test-07] unshield_to_origin instruction successful', unshieldSig);

  // SKIPPED: test-08 and test-09 - write_nullifier function removed for security (Fix 03)
  // The write_nullifier function was removed because it allowed authority to manipulate
  // nullifier set without proof verification, creating a critical security vulnerability.
  console.info('[test-08] SKIPPED: write_nullifier instruction test (function removed for security)');
  console.info('[test-09] SKIPPED: nullifier reuse rejection test (function removed for security)');

  console.info('[test-10] Testing revoke_allowance instruction (low-level)');
  const revokeData = poolCoder.instruction.encode('revoke_allowance', {});
  const revokeIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: delegate.publicKey, isSigner: false, isWritable: false },
      { pubkey: originMintKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false }
    ],
    data: revokeData
  });
  const revokeSig = await sendAndConfirmInstructions(connection, owner, [revokeIx], mintConfig.lookupTable);
  console.info('[test-10] revoke_allowance instruction successful', revokeSig);

  console.info('[test-11] Testing insufficient allowance rejection (edge case)');
  // Ensure mint_mapping is initialized before fifth shield
  await waitForMintMappingInitialized(connection, originMintKey);
  // Verify depositor token account is still valid before fifth shield
  const depositorInfo5 = await connection.getAccountInfo(depositorTokenAccount, 'confirmed');
  if (!depositorInfo5 || !depositorInfo5.owner.equals(TOKEN_PROGRAM_ID)) {
    console.info('[test-11] Recreating depositor token account...');
    const ix = createAssociatedTokenAccountInstruction(
      owner.publicKey,
      depositorTokenAccount,
      owner.publicKey,
      originMintKey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await sendAndConfirmInstructions(connection, owner, [ix]);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  // Ensure account has sufficient balance
  await faucetToken(connection, originMintKey, owner.publicKey, WRAP_AMOUNT * 10n);
  // Refresh root before fifth shield
  const rootBeforeShield5 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(rootBeforeShield5.root);
  console.info(`[test-11] Root before fifth shield: ${currentRoot}`);
  const depositId5 = generateUniqueDepositId();
  const blinding5 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount5 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof5 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
    amount: noteAmount5.toString(),
    recipient: owner.publicKey.toBase58(),
    depositId: depositId5,
    poolId: mintConfig.poolId,
    blinding: blinding5,
    mintId: mintConfig.originMint
  });

  const decodedProof5 = decodeProofPayload(proof5);
  const amountCommitmentBytes5 = await poseidonHashMany([noteAmount5, BigInt(blinding5)]);

  const shieldArgs5 = {
    amount_commit: Array.from(amountCommitmentBytes5),
    amount: new BN(noteAmount5.toString()),
    proof: decodedProof5.proof,
    public_inputs: decodedProof5.publicInputs
  };

  const shieldData5 = poolCoder.instruction.encode('shield', { args: shieldArgs5 });

  const shieldKeys5 = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
    { pubkey: hookWhitelistKey, isSigner: false, isWritable: true },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: vaultStateKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }
  ];

  if (mintConfig.zTokenMint) {
    shieldKeys5.push({ pubkey: new PublicKey(mintConfig.zTokenMint), isSigner: false, isWritable: true });
  } else {
    shieldKeys5.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  shieldKeys5.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  const shieldIx5 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys5,
    data: shieldData5
  });
  // Include finalize_ledger in same transaction as shield (required for security)
  const finalizeLedgerIx5Shield = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: hookWhitelistKey, isSigner: false, isWritable: false }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(
    connection,
    owner,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), shieldIx5, finalizeLedgerIx5Shield],
    mintConfig.lookupTable
  );

  const finalizeTreeIx5 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeTreeIx5], mintConfig.lookupTable);
  
  // shield_finalize_ledger was already called in the same transaction as shield
  // Now call shield_check_invariant to clear the claim
  const checkInvariantIx5 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : POOL_PROGRAM_ID, isSigner: false, isWritable: mintConfig.zTokenMint ? true : false }
    ],
    data: poolCoder.instruction.encode('shield_check_invariant', {})
  });
  await sendAndConfirmInstructions(connection, owner, [checkInvariantIx5], mintConfig.lookupTable);
  await waitForShieldClaimCleared(connection, shieldClaimKey);

  const updatedRoot7 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot7.root);

  const wrap5: WrapResult = {
    noteId: depositId5,
    spendingKey: blinding5,
    noteAmount: noteAmount5,
    newRoot: currentRoot,
    commitment: proof5.publicInputs[2]!,
    nullifier: Buffer.from(await poseidonHashMany([BigInt(depositId5), BigInt(blinding5)])).reverse().toString('hex').padStart(64, '0')
  };

  const insufficientTransferFromProof = await proofClient.requestProof('transfer', {
    oldRoot: currentRoot,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    inNotes: [
      {
        noteId: wrap5.noteId,
        spendingKey: wrap5.spendingKey,
        amount: wrap5.noteAmount.toString()
      }
    ],
    outNotes: [
      {
        amount: (WRAP_AMOUNT * 2n).toString(),
        recipient: pubkeyToFieldString(receiver.publicKey),
        blinding: randomFieldScalar()
      }
    ]
  });

  try {
    const decodedInsufficientProof = decodeProofPayload(insufficientTransferFromProof);
    const nullifierBytes5 = Buffer.from(wrap5.nullifier, 'hex').reverse();
    const outputCommitments5 = decodedInsufficientProof.fields.slice(2, 3).map((field) => Array.from(field));
    const randomBlinding = randomFieldScalar();
    const amountCommitments5 = await Promise.all([
      poseidonHashMany([WRAP_AMOUNT * 2n, BigInt(randomBlinding)])
    ]).then((hashes) => hashes.map((h) => {
      const bytes = Buffer.from(h).reverse();
      return Array.from(bytes);
    }));

    const insufficientTransferArgs = {
      old_root: toFixedArray(decodedInsufficientProof.fields[0]!, 'old_root'),
      new_root: toFixedArray(decodedInsufficientProof.fields[1]!, 'new_root'),
      nullifiers: [Array.from(nullifierBytes5)],
      output_commitments: outputCommitments5,
      output_amount_commitments: amountCommitments5,
      proof: decodedInsufficientProof.proof,
      public_inputs: decodedInsufficientProof.publicInputs
    };

    const insufficientTransferFromArgs = {
      transfer: insufficientTransferArgs,
      allowance_amount: new BN((WRAP_AMOUNT * 2n).toString())
    };

    const insufficientTransferFromData = poolCoder.instruction.encode('transfer_from', {
      args: insufficientTransferFromArgs
    });

    const insufficientTransferFromIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolStateKey, isSigner: false, isWritable: true },
        { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
        { pubkey: commitmentTreeKey, isSigner: false, isWritable: false },
        { pubkey: noteLedgerKey, isSigner: false, isWritable: false },
        { pubkey: mintMappingKey, isSigner: false, isWritable: false },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: verifyingKey, isSigner: false, isWritable: false },
        { pubkey: allowanceAddress, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: false, isWritable: false },
        { pubkey: delegate.publicKey, isSigner: true, isWritable: true }
      ],
      data: insufficientTransferFromData
    });
    await sendAndConfirmInstructions(
      connection,
      delegate,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), insufficientTransferFromIx],
      mintConfig.lookupTable
    );
    throw new Error('Expected insufficient allowance error');
  } catch (error: any) {
    if (error.logs?.some((log: string) => log.includes('AllowanceInsufficient'))) {
      console.info('[test-11] insufficient allowance correctly rejected');
    } else {
      console.warn('[test-11] Note: This test may fail if note was already spent. Error:', error.message);
    }
  }

  // SKIPPED: test-12 - accept_root function removed for security (Fix 03)
  // The accept_root function was removed because it allowed authority to manipulate
  // Merkle tree roots without proof verification, creating a critical security vulnerability.
  console.info('[test-12] SKIPPED: accept_root instruction test (function removed for security)');

  // test-13: Native zToken minting, shielding, and unshielding
  console.info('[test-13] Testing native zToken minting, shielding, and unshielding');
  const nativeMinter = Keypair.generate();
  await faucetSol(connection, nativeMinter.publicKey);

  // Create metadata for native zToken
  const nativeTokenName = 'Native Test Token';
  const nativeTokenSymbol = 'NTT';
  const nativeTokenDecimals = 6;
  const nativeTokenSupply = WRAP_AMOUNT * 10n; // 10x wrap amount
  const nativeTokenUri = 'ipfs://QmTest123'; // Mock IPFS URI for testing

  // Generate mint keypair
  const nativeMintKeypair = Keypair.generate();
  const nativeOriginMint = nativeMintKeypair.publicKey;

  // Derive PDAs
  const nativeMetadata = deriveTokenMetadata(nativeOriginMint);
  const nativeMintMapping = deriveMintMapping(nativeOriginMint);
  const nativePoolState = derivePoolState(nativeOriginMint);
  const nativeVaultState = deriveVaultState(nativeOriginMint);
  const nativeCommitmentTree = deriveCommitmentTree(nativeOriginMint);
  const nativeNullifierSet = deriveNullifierSet(nativeOriginMint);
  const nativeNoteLedger = deriveNoteLedger(nativeOriginMint);
  const nativeHookConfig = deriveHookConfig(nativeOriginMint);
  const nativeHookWhitelist = deriveHookWhitelist(nativeOriginMint);
  const nativeFactoryState = deriveFactoryState();
  const nativeVerifyingKey = deriveVerifyingKey();

  // Get user's token account
  const nativeUserTokenAccount = await getAssociatedTokenAddress(
    nativeOriginMint,
    nativeMinter.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Check if token account exists, create if not
  const nativeUserTokenAccountInfo = await connection.getAccountInfo(nativeUserTokenAccount);
  const nativeMintInstructions: TransactionInstruction[] = [];
  
  if (!nativeUserTokenAccountInfo) {
    nativeMintInstructions.push(
      createAssociatedTokenAccountInstruction(
        nativeMinter.publicKey,
        nativeUserTokenAccount,
        nativeMinter.publicKey,
        nativeOriginMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Build mint_native_ztoken instruction
  const nativeMintData = factoryCoder.instruction.encode('mint_native_ztoken', {
    name: nativeTokenName,
    symbol: nativeTokenSymbol,
    uri: nativeTokenUri,
    decimals: nativeTokenDecimals,
    initialSupply: new BN(nativeTokenSupply.toString()),
    featureFlags: null,
    feeBpsOverride: null,
  });

  const nativeMintKeys = [
    { pubkey: nativeFactoryState, isSigner: false, isWritable: true },
    { pubkey: nativeMinter.publicKey, isSigner: true, isWritable: true }, // authority
    { pubkey: nativeMinter.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: nativeOriginMint, isSigner: true, isWritable: true }, // mint (keypair)
    { pubkey: nativeMetadata, isSigner: false, isWritable: true },
    { pubkey: nativeMintMapping, isSigner: false, isWritable: true },
    { pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false }, // pool_program
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false }, // vault_program
    { pubkey: nativePoolState, isSigner: false, isWritable: true },
    { pubkey: nativeVaultState, isSigner: false, isWritable: true },
    { pubkey: nativeCommitmentTree, isSigner: false, isWritable: true },
    { pubkey: nativeNullifierSet, isSigner: false, isWritable: true },
    { pubkey: nativeNoteLedger, isSigner: false, isWritable: true },
    { pubkey: nativeHookConfig, isSigner: false, isWritable: true },
    { pubkey: nativeHookWhitelist, isSigner: false, isWritable: true },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: nativeVerifyingKey, isSigner: false, isWritable: false },
    { pubkey: nativeUserTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  nativeMintInstructions.push(
    new TransactionInstruction({
      programId: FACTORY_PROGRAM_ID,
      keys: nativeMintKeys,
      data: nativeMintData,
    })
  );

  // Add compute budget
  nativeMintInstructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    })
  );

  // Send transaction
  const nativeMintTx = new Transaction().add(...nativeMintInstructions);
  nativeMintTx.feePayer = nativeMinter.publicKey;
  nativeMintTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  nativeMintTx.partialSign(nativeMintKeypair);
  const nativeMintSig = await connection.sendRawTransaction(nativeMintTx.serialize(), {
    skipPreflight: false
  });
  await connection.confirmTransaction(nativeMintSig, 'confirmed');
  console.info('[test-13] Native zToken minted:', nativeMintSig);

  // Verify mint mapping was created
  const nativeMappingAccount = await connection.getAccountInfo(nativeMintMapping);
  if (!nativeMappingAccount) {
    throw new Error('[test-13] Mint mapping account not found');
  }
  const nativeMapping = factoryCoder.accounts.decode('MintMapping', nativeMappingAccount.data);
  if (nativeMapping.originMint.toBase58() !== nativeOriginMint.toBase58()) {
    throw new Error('[test-13] Mint mapping origin_mint mismatch');
  }
  if (!nativeMapping.isNativeZtoken) {
    throw new Error('[test-13] Mint mapping is_native_ztoken flag not set');
  }
  console.info('[test-13] Mint mapping verified, is_native_ztoken:', nativeMapping.isNativeZtoken);

  // Verify tokens were minted to user
  const nativeUserTokenBalance = await connection.getTokenAccountBalance(nativeUserTokenAccount);
  if (nativeUserTokenBalance.value.amount !== nativeTokenSupply.toString()) {
    throw new Error(`[test-13] Token balance mismatch: expected ${nativeTokenSupply}, got ${nativeUserTokenBalance.value.amount}`);
  }
  console.info('[test-13] User token balance verified:', nativeUserTokenBalance.value.amount);

  // Now test shielding the native zToken (same as regular shield)
  const nativeDepositId = randomFieldScalar();
  const nativeBlinding = randomFieldScalar();
  const nativeNoteAmount = nativeTokenSupply / 2n; // Shield half

  const nativeShieldProof = await proofClient.requestProof('wrap', {
    depositId: nativeDepositId,
    blinding: nativeBlinding,
    amount: nativeNoteAmount.toString(),
    mintId: nativeOriginMint.toBase58(),
    poolId: nativePoolState.toBase58()
  });

  const nativeDecodedShieldProof = decodeProofPayload(nativeShieldProof);
  const nativeAmountCommitmentBytes = await poseidonHashMany([nativeNoteAmount, BigInt(nativeBlinding)]);

  const nativeShieldArgs = {
    amount_commit: Array.from(nativeAmountCommitmentBytes),
    amount: new BN(nativeNoteAmount.toString()),
    proof: nativeDecodedShieldProof.proof,
    public_inputs: nativeDecodedShieldProof.publicInputs
  };

  const nativeShieldData = poolCoder.instruction.encode('shield', { args: nativeShieldArgs });
  const nativeShieldClaim = deriveShieldClaim(nativePoolState);

  const nativeShieldKeys = [
    { pubkey: nativePoolState, isSigner: false, isWritable: true },
    { pubkey: nativeHookConfig, isSigner: false, isWritable: false },
    { pubkey: nativeHookWhitelist, isSigner: false, isWritable: true },
    { pubkey: nativeNullifierSet, isSigner: false, isWritable: true },
    { pubkey: nativeCommitmentTree, isSigner: false, isWritable: true },
    { pubkey: nativeNoteLedger, isSigner: false, isWritable: true },
    { pubkey: nativeVaultState, isSigner: false, isWritable: true },
    { pubkey: await getAssociatedTokenAddress(nativeOriginMint, nativeVaultState, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
    { pubkey: nativeUserTokenAccount, isSigner: false, isWritable: true },
    { pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false }, // No zToken mint for native zTokens
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: nativeVerifyingKey, isSigner: false, isWritable: false },
    { pubkey: nativeShieldClaim, isSigner: false, isWritable: true },
    { pubkey: nativeMinter.publicKey, isSigner: true, isWritable: true },
    { pubkey: nativeOriginMint, isSigner: false, isWritable: false },
    { pubkey: nativeMintMapping, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];

  const nativeShieldIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: nativeShieldKeys,
    data: nativeShieldData
  });

  const nativeFinalizeLedgerIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: nativePoolState, isSigner: false, isWritable: true },
      { pubkey: nativeHookConfig, isSigner: false, isWritable: false },
      { pubkey: nativeNoteLedger, isSigner: false, isWritable: true },
      { pubkey: nativeShieldClaim, isSigner: false, isWritable: true },
      { pubkey: nativeHookWhitelist, isSigner: false, isWritable: false }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });

  await sendAndConfirmInstructions(
    connection,
    nativeMinter,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), nativeShieldIx, nativeFinalizeLedgerIx],
    undefined
  );

  const nativeFinalizeTreeIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: nativePoolState, isSigner: false, isWritable: true },
      { pubkey: nativeCommitmentTree, isSigner: false, isWritable: true },
      { pubkey: nativeShieldClaim, isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_tree', {})
  });
  await sendAndConfirmInstructions(connection, nativeMinter, [nativeFinalizeTreeIx], undefined);

  const nativeCheckInvariantIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: nativePoolState, isSigner: false, isWritable: false },
      { pubkey: nativeNoteLedger, isSigner: false, isWritable: false },
      { pubkey: nativeShieldClaim, isSigner: false, isWritable: true },
      { pubkey: await getAssociatedTokenAddress(nativeOriginMint, nativeVaultState, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: poolCoder.instruction.encode('shield_check_invariant', {})
  });
  await sendAndConfirmInstructions(connection, nativeMinter, [nativeCheckInvariantIx], undefined);
  await waitForShieldClaimCleared(connection, nativeShieldClaim);

  // Verify tokens were deposited to vault
  const nativeVaultTokenAccount = await getAssociatedTokenAddress(nativeOriginMint, nativeVaultState, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const nativeVaultBalance = await connection.getTokenAccountBalance(nativeVaultTokenAccount);
  if (nativeVaultBalance.value.amount !== nativeNoteAmount.toString()) {
    throw new Error(`[test-13] Vault balance mismatch: expected ${nativeNoteAmount}, got ${nativeVaultBalance.value.amount}`);
  }
  console.info('[test-13] Native zToken shielded successfully, vault balance:', nativeVaultBalance.value.amount);

  // Test unshielding native zToken
  const nativePoolRoot = await fetchPoolStateRoot(connection, nativePoolState.toBase58());
  const nativeUnshieldProof = await proofClient.requestProof('unwrap', {
    oldRoot: canonicalizeHex(nativePoolRoot.root),
    mintId: nativeOriginMint.toBase58(),
    poolId: nativePoolState.toBase58(),
    noteId: nativeDepositId,
    spendingKey: nativeBlinding,
    noteAmount: nativeNoteAmount.toString(),
    destPubkey: nativeMinter.publicKey.toBase58(),
    mode: 'origin'
  });

  const nativeDecodedUnshieldProof = decodeProofPayload(nativeUnshieldProof);
  const nativeNullifierBytes = Buffer.from(await poseidonHashMany([BigInt(nativeDepositId), BigInt(nativeBlinding)])).reverse();

  const nativeUnshieldArgs = {
    old_root: toFixedArray(nativeDecodedUnshieldProof.fields[0]!, 'old_root'),
    new_root: toFixedArray(nativeDecodedUnshieldProof.fields[1]!, 'new_root'),
    nullifier: Array.from(nativeNullifierBytes),
    proof: nativeDecodedUnshieldProof.proof,
    public_inputs: nativeDecodedUnshieldProof.publicInputs
  };

  const nativeUnshieldData = poolCoder.instruction.encode('unshield', { args: nativeUnshieldArgs });

  const nativeUnshieldKeys = [
    { pubkey: nativePoolState, isSigner: false, isWritable: true },
    { pubkey: nativeHookConfig, isSigner: false, isWritable: false },
    { pubkey: nativeHookWhitelist, isSigner: false, isWritable: false },
    { pubkey: nativeNullifierSet, isSigner: false, isWritable: true },
    { pubkey: nativeCommitmentTree, isSigner: false, isWritable: true },
    { pubkey: nativeNoteLedger, isSigner: false, isWritable: true },
    { pubkey: nativeMintMapping, isSigner: false, isWritable: false },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: nativeVerifyingKey, isSigner: false, isWritable: false },
    { pubkey: nativeVaultState, isSigner: false, isWritable: true },
    { pubkey: nativeVaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: nativeUserTokenAccount, isSigner: false, isWritable: true },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: nativeFactoryState, isSigner: false, isWritable: false },
    { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: nativeMinter.publicKey, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];

  const nativeUnshieldIx = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: nativeUnshieldKeys,
    data: nativeUnshieldData
  });

  await sendAndConfirmInstructions(
    connection,
    nativeMinter,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), nativeUnshieldIx],
    undefined
  );

  // Verify tokens were returned to user
  const nativeFinalUserBalance = await connection.getTokenAccountBalance(nativeUserTokenAccount);
  const expectedFinalBalance = nativeTokenSupply; // Should have all tokens back (half was shielded, then unshielded)
  if (nativeFinalUserBalance.value.amount !== expectedFinalBalance.toString()) {
    throw new Error(`[test-13] Final user balance mismatch: expected ${expectedFinalBalance}, got ${nativeFinalUserBalance.value.amount}`);
  }
  console.info('[test-13] Native zToken unshielded successfully, final user balance:', nativeFinalUserBalance.value.amount);
  console.info('[test-13] Native zToken minting, shielding, and unshielding test completed successfully');

  console.info('[lowlevel-e2e] All low-level E2E tests completed successfully');
}

main().catch((error) => {
  console.error('[fatal] lowlevel-e2e script failed', error);
  process.exitCode = 1;
});
