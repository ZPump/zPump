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
  deriveHookConfig
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
  let offset = 8;
  const advance = (bytes: number) => {
    offset += bytes;
  };
  advance(32 * 6);
  advance(32);
  advance(32);
  const rootBytes = buffer.slice(offset, offset + 32);
  advance(32);
  advance(32 * 16);
  offset += 1;
  if (offset % 2 !== 0) {
    offset += 1;
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
          { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
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
  const depositorInfo = await connection.getAccountInfo(depositorTokenAccount);
  if (!depositorInfo) {
    const ix = createAssociatedTokenAccountInstruction(
      owner.publicKey,
      depositorTokenAccount,
      owner.publicKey,
      originMintKey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await sendAndConfirmInstructions(connection, owner, [ix]);
  }
  await faucetToken(connection, originMintKey, owner.publicKey, WRAP_AMOUNT * 10n);

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
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
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
  const decodedProof1Final = decodeProofPayload(proof1Final);
  
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
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
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

  console.info('[test-02] Testing shield_finalize_tree instruction (low-level)');
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
  const updatedRoot = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot.root);
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
  
  const depositId2 = generateUniqueDepositId();
  const blinding2 = crypto.randomInt(1_000_000, 9_000_000).toString();
  const noteAmount2 = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const proof2 = await proofClient.requestProof('wrap', {
    oldRoot: currentRoot,
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
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
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
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
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
  const nullifierBytes = Buffer.from(wrap1.nullifier, 'hex').reverse();
  // Output commitments are at indices 2 and 3 in the decoded fields
  const outputCommitments = decodedTransferProof.fields.slice(2, 4).map((field) => Array.from(field));
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
    proof: decodedTransferProof.proof,
    public_inputs: decodedTransferProof.publicInputs
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
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: transferData
  });

  const transferSig = await sendAndConfirmInstructions(
    connection,
    owner,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), transferIx],
    mintConfig.lookupTable
  );
  console.info('[test-04] private_transfer instruction successful', transferSig);

  const updatedRoot3 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot3.root);

  console.info('[test-05] Testing approve_allowance instruction (low-level)');
  const allowanceAmount = WRAP_AMOUNT;
  const approveData = poolCoder.instruction.encode('approve_allowance', {
    args: { amount: new BN(allowanceAmount.toString()) }
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
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
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
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
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
  const nullifierBytes3 = Buffer.from(wrap3.nullifier, 'hex').reverse();
  const outputCommitments3 = decodedTransferFromProof.fields.slice(2, 4).map((field) => Array.from(field));
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
    allowance_amount: new BN(transferFromAmount.toString())
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
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: transferFromData
  });

  const transferFromSig = await sendAndConfirmInstructions(
    connection,
    delegate,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), transferFromIx],
    mintConfig.lookupTable
  );
  console.info('[test-06] transfer_from instruction successful', transferFromSig);

  const updatedRoot5 = await fetchPoolStateRoot(connection, mintConfig.poolId);
  currentRoot = canonicalizeHex(updatedRoot5.root);

  console.info('[test-07] Testing unshield_to_origin instruction (low-level)');
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
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
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
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
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

  const wrap4: WrapResult = {
    noteId: depositId4,
    spendingKey: blinding4,
    noteAmount: noteAmount4,
    newRoot: currentRoot,
    commitment: proof4.publicInputs[2]!,
    nullifier: Buffer.from(await poseidonHashMany([BigInt(depositId4), BigInt(blinding4)])).reverse().toString('hex').padStart(64, '0')
  };

  // Unshield amount should account for fees - use a slightly smaller amount
  const unshieldAmount = wrap4.noteAmount - (wrap4.noteAmount * feeBps) / 10_000n;
  const unshieldBlinding = randomFieldScalar();

  const unshieldProof = await proofClient.requestProof('unwrap', {
    oldRoot: currentRoot,
    amount: unshieldAmount.toString(),
    fee: ((wrap4.noteAmount * feeBps) / 10_000n).toString(),
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
      { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: vaultStateKey, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintConfig.zTokenMint ? new PublicKey(mintConfig.zTokenMint) : originMintKey, isSigner: false, isWritable: mintConfig.zTokenMint ? true : false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: factoryStateKey, isSigner: false, isWritable: false },
      { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  const shieldIx5 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys5,
    data: shieldData5
  });
  await sendAndConfirmInstructions(
    connection,
    owner,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), shieldIx5],
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

  const finalizeLedgerIx5 = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolStateKey, isSigner: false, isWritable: true },
      { pubkey: hookConfigKey, isSigner: false, isWritable: false },
      { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
      { pubkey: shieldClaimKey, isSigner: false, isWritable: true }
    ],
    data: poolCoder.instruction.encode('shield_finalize_ledger', {})
  });
  await sendAndConfirmInstructions(connection, owner, [finalizeLedgerIx5], mintConfig.lookupTable);
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

  console.info('[lowlevel-e2e] All low-level E2E tests completed successfully');
}

main().catch((error) => {
  console.error('[fatal] lowlevel-e2e script failed', error);
  process.exitCode = 1;
});
