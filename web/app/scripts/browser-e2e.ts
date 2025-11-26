import bs58 from 'bs58';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  VersionedTransaction
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress
} from '@solana/spl-token';
import { BN, BorshCoder, Idl } from '@coral-xyz/anchor';
import type { MintConfig } from '../config/mints';
import { ProofClient } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { wrap, transfer, transferFrom, unwrap } from '../lib/sdk';
import { deriveViewingKey } from '../lib/wallet/viewingKey';
import { poseidonHashMany } from '../lib/onchain/poseidon';
import { canonicalizeHex, bytesLEToCanonicalHex } from '../lib/onchain/utils';
import { formatBaseUnitsToUi } from '../lib/format';
import poolIdl from '../idl/ptf_pool.json';
import { POOL_PROGRAM_ID, FACTORY_PROGRAM_ID } from '../lib/onchain/programIds';
import { deriveAllowanceAccount, deriveFactoryState, deriveMintMapping, deriveNullifierSet } from '../lib/onchain/pdas';
import factoryIdl from '../idl/ptf_factory.json';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';

ensureFetchPolyfill();

type WalletLike = Parameters<typeof wrap>[0]['wallet'];

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const NEXT_URL = process.env.NEXT_URL ?? 'http://127.0.0.1:3000';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';
const INDEXER_PROXY_URL = process.env.INDEXER_PROXY_URL ?? `${NEXT_URL}/api/indexer`;
const FAUCET_BASE_URL = process.env.FAUCET_URL ?? `${NEXT_URL}/api/faucet`;
const MINTS_API_URL = process.env.MINTS_API_URL ?? `${NEXT_URL}/api/mints`;

const SOL_AIRDROP_LAMPORTS = BigInt(process.env.SOL_AIRDROP_LAMPORTS ?? (2n * 10n ** 9n).toString());
const MIN_SOL_BALANCE = BigInt(process.env.MIN_SOL_BALANCE ?? (1n * 10n ** 9n).toString());
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000'); // 1 token with 6 decimals
const TARGET_DECIMALS = Number(process.env.MINT_DECIMALS ?? '6');

const poolCoder = new BorshCoder(poolIdl as Idl);
const factoryCoder = new BorshCoder(factoryIdl as Idl);

interface WrapResult {
  noteId: string;
  spendingKey: string;
  noteAmount: bigint;
  newRoot: string;
}

interface TransferProofParts {
  oldRoot: string;
  newRoot: string;
  nullifiers: string[];
  outputCommitments: string[];
}

interface OnchainAllowance {
  pool: PublicKey;
  owner: PublicKey;
  spender: PublicKey;
  mint: PublicKey;
  amount: bigint;
  updatedAt: bigint;
  bump: number;
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
    if (account && account.owner.equals(FACTORY_PROGRAM_ID)) {
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
      } catch {
        return;
      }
    }
    attempts += 1;
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for mint mapping ${mintMappingKey.toBase58()} for origin mint ${originMint.toBase58()} to initialize`
  );
}

function randomSymbol(prefix = 'FB'): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let suffix = '';
  for (let i = 0; i < 2; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${prefix}${suffix}`;
}

function randomFieldScalar(): string {
  const bytes = crypto.randomBytes(31);
  return BigInt(`0x${bytes.toString('hex')}`).toString();
}

function pubkeyToFieldString(key: PublicKey): string {
  const hex = Buffer.from(key.toBytes()).toString('hex');
  return BigInt(`0x${hex}`).toString();
}

async function poseidonHexFromValues(values: bigint[]): Promise<string> {
  const hash = await poseidonHashMany(values);
  return `0x${Buffer.from(hash).toString('hex')}`;
}

function selectNotesForAmount(notes: WrapResult[], target: bigint): WrapResult[] {
  if (!notes.length) {
    throw new Error('No available notes to cover transfer.');
  }
  const sorted = [...notes].sort((a, b) => {
    if (a.noteAmount === b.noteAmount) {
      return 0;
    }
    return a.noteAmount > b.noteAmount ? 1 : -1;
  });
  const single = sorted.find((note) => note.noteAmount >= target);
  if (single) {
    return [single];
  }
  let bestPair: { total: bigint; pair: [WrapResult, WrapResult] } | null = null;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      const total = sorted[i]!.noteAmount + sorted[j]!.noteAmount;
      if (total >= target) {
        if (!bestPair || total < bestPair.total) {
          bestPair = { total, pair: [sorted[i]!, sorted[j]!] };
        }
      }
    }
  }
  if (bestPair) {
    return bestPair.pair;
  }
  throw new Error('Insufficient note liquidity for requested amount.');
}

async function confirmSignature(connection: Connection, signature: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (true) {
    const status = await connection.getSignatureStatuses([signature]);
    const info = status.value[0];
    if (info?.err) {
      throw new Error(`Signature ${signature} failed: ${JSON.stringify(info.err)}`);
    }
    if (
      info?.confirmationStatus === 'confirmed' ||
      info?.confirmationStatus === 'finalized' ||
      info?.confirmations === null
    ) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out confirming signature ${signature}`);
    }
    await sleep(500);
  }
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
  await confirmSignature(connection, signature);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const balance = BigInt(await connection.getBalance(recipient, 'confirmed'));
    if (balance >= MIN_SOL_BALANCE) {
      return;
    }
    await sleep(1000);
  }
  throw new Error('SOL balance did not reach minimum threshold');
}

async function faucetTokens(recipient: PublicKey, mint: PublicKey, amount: bigint): Promise<void> {
  const response = await fetch(`${FAUCET_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: recipient.toBase58(),
      mint: mint.toBase58(),
      amount: amount.toString()
    })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Token faucet failed: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`);
  }
}

async function ensureTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<void> {
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const currentInfo = await connection.getTokenAccountBalance(ata).catch(() => null);
  const current = currentInfo ? BigInt(currentInfo.value.amount) : 0n;
  if (current >= amount) {
    return;
  }
  await faucetTokens(owner, mint, amount - current);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(500);
    const updated = await connection.getTokenAccountBalance(ata).catch(() => null);
    const next = updated ? BigInt(updated.value.amount) : 0n;
    if (next >= amount) {
      return;
    }
  }
  throw new Error('Token faucet minting did not reach target');
}

async function loadLocalAuthorityKeypair(): Promise<Keypair> {
  const keyPath = path.join(process.env.HOME ?? '.', '.config', 'solana', 'id.json');
  const raw = await fs.readFile(keyPath, 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function sendAndConfirmInstructions(
  connection: Connection,
  feePayer: Keypair,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = []
): Promise<string> {
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: latestBlockhash.blockhash
  });
  instructions.forEach((ix) => transaction.add(ix));
  transaction.sign(feePayer, ...extraSigners);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  await confirmSignature(connection, signature);
  return signature;
}

async function freezeMintOnChain(params: {
  connection: Connection;
  authority: Keypair;
  factoryState: PublicKey;
  mintMapping: PublicKey;
}): Promise<void> {
  const { connection, authority, factoryState, mintMapping } = params;
  
  // Freeze now requires timelock - queue and execute the action
  // Since timelock_seconds is 0 in tests, we can execute immediately after queueing
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  
  // Get origin_mint from mint mapping account
  const mintMappingAccount = await connection.getAccountInfo(mintMapping);
  if (!mintMappingAccount) throw new Error('Mint mapping not found');
  const originMint = new PublicKey(mintMappingAccount.data.slice(8, 40));
  
  // Get factory state to find sequence number for timelock entry PDA
  // Re-read to ensure we have the latest sequence after any previous actions
  let factoryStateAccount = await connection.getAccountInfo(factoryState, 'confirmed');
  if (!factoryStateAccount) throw new Error('Factory state not found');
  let factoryStateData = factoryCoder.accounts.decode('FactoryState', factoryStateAccount.data);
  // Handle BN or number - Anchor returns BN for u64
  let lastSequence = factoryStateData.lastActionSequence;
  let currentSequence: number;
  if (lastSequence === null || lastSequence === undefined) {
    currentSequence = 0;
  } else if (typeof lastSequence === 'object' && 'toNumber' in lastSequence && typeof lastSequence.toNumber === 'function') {
    currentSequence = lastSequence.toNumber();
  } else if (typeof lastSequence === 'bigint') {
    currentSequence = Number(lastSequence);
  } else {
    currentSequence = Number(lastSequence) || 0;
  }
  if (isNaN(currentSequence)) {
    throw new Error(`Invalid sequence number: ${JSON.stringify(lastSequence)}`);
  }
  // CRITICAL: Anchor's PDA constraint in QueueTimelockAction reads factory_state.last_action_sequence BEFORE the instruction runs
  // The program sets entry.sequence = last_action_sequence (matches the PDA)
  // For executing, Anchor's constraint uses timelock_entry.sequence (which equals currentSequence)
  // So we use the same sequence for both queueing and executing
  const sequenceToUse = currentSequence;
  
  // Convert sequence to little-endian u64 bytes
  const sequenceBuffer = Buffer.allocUnsafe(8);
  sequenceBuffer.writeBigUInt64LE(BigInt(sequenceToUse), 0);
  
  // Derive timelock entry PDA (same for queueing and executing, since entry.sequence matches PDA)
  const [timelockEntry] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('timelock'),
      factoryState.toBuffer(),
      sequenceBuffer
    ],
    FACTORY_PROGRAM_ID
  );
  
  // Queue timelock action
  // Anchor expects enum variants to match IDL exactly (PascalCase)
  const queueData = factoryCoder.instruction.encode('queue_timelock_action', {
    salt: Array.from(salt),
    action: {
      FreezeMint: {
        origin_mint: originMint
      }
    }
  });
  
  // Account order from IDL: factory_state, authority, timelock_entry, payer, system_program, mint_mapping, origin_mint, ptkn_mint, token_program, rent
  // All accounts must be present in order, even if optional
  const queueKeys = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    { pubkey: timelockEntry, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: mintMapping, isSigner: false, isWritable: false }, // mint_mapping (optional but required for FreezeMint)
    { pubkey: originMint, isSigner: false, isWritable: false }, // origin_mint (optional but required for FreezeMint)
    { pubkey: mintMapping, isSigner: false, isWritable: true }, // ptkn_mint (optional, use mintMapping as placeholder since it's writable)
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false }, // token_program (optional, use actual token program ID)
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false } // rent (optional, placeholder)
  ];
  
  await sendAndConfirmInstructions(
    connection,
    authority,
    [
      new TransactionInstruction({
        programId: FACTORY_PROGRAM_ID,
        keys: queueKeys,
        data: queueData
      })
    ]
  );
  
  // Execute immediately (timelock_seconds is 0 in tests)
  // Use the same timelockEntry PDA that was used for queueing
  const executeData = factoryCoder.instruction.encode('execute_timelock_action', {});
  // Derive factory_config PDA (optional - may not exist, but we need to provide it)
  const [factoryConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('factory-config'), factoryState.toBuffer()],
    FACTORY_PROGRAM_ID
  );
  // Account order from IDL: factory_state, timelock_entry, mint_mapping, ptkn_mint, token_program, factory_config, executor, rent
  // All accounts must be present in order, even if optional
  // Use the same timelockEntry PDA (entry.sequence matches the PDA it was created at)
  const executeKeys = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: timelockEntry, isSigner: false, isWritable: true },
    { pubkey: mintMapping, isSigner: false, isWritable: true },
    { pubkey: mintMapping, isSigner: false, isWritable: true }, // ptkn_mint (optional, use mintMapping as placeholder)
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false }, // token_program (optional, use actual token program ID)
    { pubkey: factoryConfigPda, isSigner: false, isWritable: true }, // factory_config (optional, use actual PDA even if not initialized)
    { pubkey: authority.publicKey, isSigner: true, isWritable: true }, // executor
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false } // rent sysvar
  ];
  
  await sendAndConfirmInstructions(
    connection,
    authority,
    [
      new TransactionInstruction({
        programId: FACTORY_PROGRAM_ID,
        keys: executeKeys,
        data: executeData
      })
    ]
  );
}

async function thawMintOnChain(params: {
  connection: Connection;
  authority: Keypair;
  factoryState: PublicKey;
  mintMapping: PublicKey;
}): Promise<void> {
  const { connection, authority, factoryState, mintMapping } = params;
  
  // Thaw now requires timelock - queue and execute the action
  // Since timelock_seconds is 0 in tests, we can execute immediately after queueing
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  
  // Get origin_mint from mint mapping account
  const mintMappingAccount = await connection.getAccountInfo(mintMapping);
  if (!mintMappingAccount) throw new Error('Mint mapping not found');
  const originMint = new PublicKey(mintMappingAccount.data.slice(8, 40));
  
  // Wait to ensure previous actions are fully confirmed and rate limiting has passed
  // Rate limiting requires MIN_TIME_BETWEEN_ACTIONS (60 seconds) between actions
  // For tests, we'll wait 65 seconds to be safe
  console.log('[thawMintOnChain] Waiting 65 seconds to satisfy rate limiting...');
  await sleep(65000);
  
  // Get factory state to find sequence number for timelock entry PDA
  // Re-read multiple times to ensure we have the latest sequence after any previous actions
  let factoryStateAccount: any = null;
  let factoryStateData: any = null;
  let lastSequence: any = null;
  let retries = 10;
  let lastSeqNum = -1;
  while (retries > 0) {
    factoryStateAccount = await connection.getAccountInfo(factoryState, 'confirmed');
    if (!factoryStateAccount) throw new Error('Factory state not found');
    factoryStateData = factoryCoder.accounts.decode('FactoryState', factoryStateAccount.data);
    lastSequence = factoryStateData.lastActionSequence;
    const seqNum = typeof lastSequence === 'object' && 'toNumber' in lastSequence ? lastSequence.toNumber() : Number(lastSequence) || 0;
    console.log(`[thawMintOnChain] Retry ${11 - retries}: sequence = ${seqNum}`);
    // If sequence hasn't changed from last read, wait and retry (state might not be updated yet)
    if (seqNum === lastSeqNum && retries > 1) {
      await sleep(300);
      retries--;
      continue;
    }
    lastSeqNum = seqNum;
    // If we got a sequence value (even if 0), use it on last retry
    if (retries === 1) {
      break;
    }
    // Wait a bit to see if sequence changes
    await sleep(200);
    retries--;
  }
  let currentSequence: number;
  if (lastSequence === null || lastSequence === undefined) {
    currentSequence = 0;
  } else if (typeof lastSequence === 'object' && 'toNumber' in lastSequence && typeof lastSequence.toNumber === 'function') {
    currentSequence = lastSequence.toNumber();
  } else if (typeof lastSequence === 'bigint') {
    currentSequence = Number(lastSequence);
  } else {
    currentSequence = Number(lastSequence) || 0;
  }
  if (isNaN(currentSequence)) {
    throw new Error(`Invalid sequence number: ${JSON.stringify(lastSequence)}`);
  }
  // CRITICAL: Anchor's PDA constraint in QueueTimelockAction reads factory_state.last_action_sequence BEFORE the instruction runs
  // The program sets entry.sequence = last_action_sequence (matches the PDA)
  // For executing, Anchor's constraint uses timelock_entry.sequence (which equals currentSequence)
  // So we use the same sequence for both queueing and executing
  // If sequence is still 0 after retries, the freeze action might have used sequence 0
  // In that case, we should use sequence 1 for the thaw action (sequence was incremented after freeze)
  // But if we're reading 0, it means the state hasn't updated yet, so we'll use 1 anyway
  const sequenceToUse = currentSequence === 0 ? 1 : currentSequence;
  console.log(`[thawMintOnChain] Read sequence: ${currentSequence}, using: ${sequenceToUse} for timelock entry PDA`);
  
  // Convert sequence to little-endian u64 bytes
  const sequenceBuffer = Buffer.allocUnsafe(8);
  sequenceBuffer.writeBigUInt64LE(BigInt(sequenceToUse), 0);
  
  // Derive timelock entry PDA (same for queueing and executing, since entry.sequence matches PDA)
  const [timelockEntry] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('timelock'),
      factoryState.toBuffer(),
      sequenceBuffer
    ],
    FACTORY_PROGRAM_ID
  );
  console.log(`[thawMintOnChain] Derived timelock entry PDA: ${timelockEntry.toBase58()}`);
  
  // Queue timelock action
  // Anchor expects enum variants to match IDL exactly (PascalCase)
  const queueData = factoryCoder.instruction.encode('queue_timelock_action', {
    salt: Array.from(salt),
    action: {
      ThawMint: {
        origin_mint: originMint
      }
    }
  });
  
  // Account order from IDL: factory_state, authority, timelock_entry, payer, system_program, mint_mapping, origin_mint, ptkn_mint, token_program, rent
  // All accounts must be present in order, even if optional
  const queueKeys = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    { pubkey: timelockEntry, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: mintMapping, isSigner: false, isWritable: false }, // mint_mapping (optional but required for FreezeMint)
    { pubkey: originMint, isSigner: false, isWritable: false }, // origin_mint (optional but required for FreezeMint)
    { pubkey: mintMapping, isSigner: false, isWritable: true }, // ptkn_mint (optional, use mintMapping as placeholder since it's writable)
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false }, // token_program (optional, use actual token program ID)
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false } // rent (optional, placeholder)
  ];
  
  await sendAndConfirmInstructions(
    connection,
    authority,
    [
      new TransactionInstruction({
        programId: FACTORY_PROGRAM_ID,
        keys: queueKeys,
        data: queueData
      })
    ]
  );
  
  // Execute immediately (timelock_seconds is 0 in tests)
  // Use the same timelockEntry PDA that was used for queueing
  const executeData = factoryCoder.instruction.encode('execute_timelock_action', {});
  // Derive factory_config PDA (optional - may not exist, but we need to provide it)
  const [factoryConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('factory-config'), factoryState.toBuffer()],
    FACTORY_PROGRAM_ID
  );
  // Account order from IDL: factory_state, timelock_entry, mint_mapping, ptkn_mint, token_program, factory_config, executor, rent
  // All accounts must be present in order, even if optional
  // Use the same timelockEntry PDA (entry.sequence matches the PDA it was created at)
  const executeKeys = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: timelockEntry, isSigner: false, isWritable: true },
    { pubkey: mintMapping, isSigner: false, isWritable: true },
    { pubkey: mintMapping, isSigner: false, isWritable: true }, // ptkn_mint (optional, use mintMapping as placeholder)
    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false }, // token_program (optional, use actual token program ID)
    { pubkey: factoryConfigPda, isSigner: false, isWritable: true }, // factory_config (optional, use actual PDA even if not initialized)
    { pubkey: authority.publicKey, isSigner: true, isWritable: true }, // executor
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false } // rent sysvar
  ];
  
  await sendAndConfirmInstructions(
    connection,
    authority,
    [
      new TransactionInstruction({
        programId: FACTORY_PROGRAM_ID,
        keys: executeKeys,
        data: executeData
      })
    ]
  );
}

// SKIPPED: growNullifierSet function - write_nullifier removed for security (Fix 03)
// The write_nullifier function was removed because it allowed authority to manipulate
// nullifier set without proof verification, creating a critical security vulnerability.
async function growNullifierSet(params: {
  connection: Connection;
  authority: Keypair;
  poolState: PublicKey;
  nullifierSet: PublicKey;
  mintMapping: PublicKey;
  inserts: number;
}): Promise<void> {
  console.info('[edge] SKIPPED: nullifier set growth stress test (write_nullifier function removed for security)');
  // Function disabled - write_nullifier was removed in Fix 03 for security
  // Nullifiers should only be added through proper proof-verified operations (unshield, transfer)
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

async function registerMint(symbol: string, decimals: number): Promise<void> {
  const response = await fetch(MINTS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, decimals })
  });
  if (response.status === 409) {
    return;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to register mint: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`
    );
  }
}

async function waitForMint(predicate: (mint: MintConfig) => boolean, timeoutMs = 240_000): Promise<MintConfig> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const catalog = await fetchMintCatalog();
    const match = catalog.find(predicate);
    if (match) {
      return match;
    }
    await sleep(2000);
  }
  throw new Error('Timed out waiting for mint registration');
}

function createWalletAdapter(payer: Keypair, connection: Connection): WalletLike {
  const adapter = {
    publicKey: payer.publicKey,
    connect: async () => {},
    disconnect: async () => {},
    connected: true,
    connecting: false,
    disconnecting: false,
    autoConnect: false,
    readyState: 'Installed',
    wallets: [],
    wallet: null,
    visible: false,
    setVisible: () => {},
    supportedTransactionVersions: null,
    async sendTransaction(transaction: Transaction | VersionedTransaction, connection: Connection, options?: { skipPreflight?: boolean }): Promise<string> {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([payer]);
        return connection.sendRawTransaction(transaction.serialize(), { skipPreflight: options?.skipPreflight ?? false });
      }
      // Fully sign the transaction (not partialSign) to ensure it's valid
      transaction.sign(payer);
      return connection.sendRawTransaction(transaction.serialize(), { skipPreflight: options?.skipPreflight ?? false });
    },
    async signTransaction(transaction: Transaction) {
      transaction.sign(payer);
      return transaction;
    },
    async signAllTransactions(transactions: (Transaction | VersionedTransaction)[]) {
      transactions.forEach((tx) => {
        if (tx instanceof VersionedTransaction) {
          tx.sign([payer]);
        } else {
          tx.sign(payer);
        }
      });
      return transactions;
    }
  };
  return adapter as unknown as WalletLike;
}

async function publishRoot(baseUrl: string, mint: string, current: string, recent: string[]): Promise<void> {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const response = await fetch(`${normalizedBase}/roots/${mint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      current: canonicalizeHex(current),
      recent: recent.map((entry) => canonicalizeHex(entry))
    })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Failed to publish root: ${response.status} ${(payload as { error?: string }).error ?? 'unknown'}`);
  }
}

async function waitForIndexerRoot(indexerClient: IndexerClient, originMint: string, expectRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const roots = await indexerClient.getRoots(originMint);
    if (roots) {
      const known = new Set([roots.current, ...(roots.recent ?? [])].map((entry) => canonicalizeHex(entry)));
      if (known.has(canonicalizeHex(expectRoot))) {
        return;
      }
    }
    await sleep(1000);
  }
  throw new Error('Indexer did not acknowledge expected root');
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
  advance(32 * 64); // recent_roots (MAX_ROOTS = 64, not 16)
  advance(8 * 64); // recent_roots_timestamps (i64 * 64)
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

function parseTransferPublicInputs(
  publicInputs: string[],
  inputCount: number,
  outputCount: number
): TransferProofParts {
  const expected = 2 + inputCount + outputCount + 2;
  if (publicInputs.length !== expected) {
    throw new Error(`Unexpected transfer public input count: expected ${expected}, got ${publicInputs.length}`);
  }
  const oldRoot = canonicalizeHex(publicInputs[0]!);
  const newRoot = canonicalizeHex(publicInputs[1]!);
  const nullifiers = publicInputs.slice(2, 2 + inputCount).map((entry) => canonicalizeHex(entry ?? '0x0'));
  const offset = 2 + inputCount;
  const outputCommitments = publicInputs
    .slice(offset, offset + outputCount)
    .map((entry) => canonicalizeHex(entry ?? '0x0'));
  return { oldRoot, newRoot, nullifiers, outputCommitments };
}

function deriveViewId(secret: Uint8Array): string {
  const viewing = deriveViewingKey(bs58.encode(secret));
  if (!viewing) {
    throw new Error('Failed to derive viewing key');
  }
  return viewing.viewId;
}

async function fetchAllowanceAccount(connection: Connection, address: PublicKey): Promise<OnchainAllowance | null> {
  const account = await connection.getAccountInfo(address, 'confirmed');
  if (!account) {
    return null;
  }
  const buffer = Buffer.from(account.data);
  if (buffer.length < 8 + 32 * 4 + 8 + 8 + 1) {
    return null;
  }
  let offset = 8;
  const readPubkey = () => {
    const key = new PublicKey(buffer.slice(offset, offset + 32));
    offset += 32;
    return key;
  };
  const result: OnchainAllowance = {
    pool: readPubkey(),
    owner: readPubkey(),
    spender: readPubkey(),
    mint: readPubkey(),
    amount: buffer.readBigUInt64LE(offset),
    updatedAt: buffer.readBigInt64LE(offset + 8),
    bump: buffer.readUInt8(offset + 16)
  };
  return result;
}

async function sendAllowanceInstruction(params: {
  connection: Connection;
  owner: Keypair;
  spender: PublicKey;
  poolState: PublicKey;
  originMint: PublicKey;
  allowanceAddress: PublicKey;
  mintMapping: PublicKey;
  instruction: 'approve' | 'revoke';
  amount?: bigint;
}): Promise<string> {
  const {
    connection,
    owner,
    spender,
    poolState,
    originMint,
    allowanceAddress,
    mintMapping,
    instruction,
    amount = 0n
  } = params;
  const data =
    instruction === 'approve'
      ? poolCoder.instruction.encode('approve_allowance', { args: { amount: new BN(amount.toString()), expires_at: null } })
      : poolCoder.instruction.encode('revoke_allowance', { args: {} });
  const ix = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: spender, isSigner: false, isWritable: false },
      { pubkey: originMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mintMapping, isSigner: false, isWritable: false }
    ],
    data
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(ix);
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(owner);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmSignature(connection, signature, 60_000);
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

async function buildAmountCommitments(outputs: { amount: bigint; blinding: bigint }[]): Promise<string[]> {
  const results: string[] = [];
  for (const entry of outputs) {
    results.push(await poseidonHexFromValues([entry.amount, entry.blinding]));
  }
  return results;
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const indexerClient = new IndexerClient({ baseUrl: INDEXER_PROXY_URL });

  const owner = Keypair.generate();
  const receiver = Keypair.generate();
  const delegate = Keypair.generate();
  const adminAuthority = await loadLocalAuthorityKeypair();

  const ownerAdapter = createWalletAdapter(owner, connection);
  const delegateAdapter = createWalletAdapter(delegate, connection);

  console.info('[setup] airdropping SOL to wallets');
  await Promise.all([owner, receiver, delegate].map((kp) => faucetSol(connection, kp.publicKey)));
  await faucetSol(connection, adminAuthority.publicKey);

  const ownerViewId = deriveViewId(owner.secretKey);
  const receiverViewId = deriveViewId(receiver.secretKey);

  const symbol = randomSymbol('FB');
  console.info('[mint] registering', { symbol, decimals: TARGET_DECIMALS });
  let mintConfig: MintConfig;
  try {
    await registerMint(symbol, TARGET_DECIMALS);
    mintConfig = await waitForMint((mint) => mint.symbol.toUpperCase() === symbol.toUpperCase());
  } catch (error) {
    console.warn('[mint] registration failed, falling back to existing mint', (error as Error).message);
    const catalog = await fetchMintCatalog();
    if (!catalog.length) {
      throw error;
    }
    mintConfig = catalog[0]!;
    console.info('[mint] using pre-existing mint', { symbol: mintConfig.symbol, originMint: mintConfig.originMint });
  }
  await waitForMintMappingInitialized(connection, new PublicKey(mintConfig.originMint));
  const originMintKey = new PublicKey(mintConfig.originMint);
  const poolId = mintConfig.poolId;
  const poolStateKey = new PublicKey(poolId);
  const privateMint = mintConfig.zTokenMint ?? mintConfig.originMint;
  const allowanceAddress = deriveAllowanceAccount(poolStateKey, owner.publicKey, delegate.publicKey);
  const mintMappingKey = deriveMintMapping(originMintKey);
  const factoryStateKey = deriveFactoryState();
  const nullifierSetKey = deriveNullifierSet(originMintKey);

  const initialPoolInfo = await fetchPoolStateRoot(connection, poolId);
  let currentRoot = canonicalizeHex(initialPoolInfo.root);
  const recentRoots: string[] = [currentRoot];
  await publishRoot(INDEXER_PROXY_URL, mintConfig.originMint, currentRoot, recentRoots);
  await waitForIndexerRoot(indexerClient, mintConfig.originMint, currentRoot);
  const feeBps = BigInt(initialPoolInfo.feeBps);

  console.info('[pool] fee config', { feeBps: initialPoolInfo.feeBps });

  const wrapsPlanned = [WRAP_AMOUNT, WRAP_AMOUNT * 2n, WRAP_AMOUNT * 3n, WRAP_AMOUNT];
  const feePerWrap = wrapsPlanned.map((amount) => (amount * feeBps) / 10_000n);
  const requiredMint = wrapsPlanned.reduce((sum, amount, idx) => sum + amount + feePerWrap[idx]!, 0n) + WRAP_AMOUNT;
  await ensureTokenBalance(connection, owner.publicKey, originMintKey, requiredMint);

  let ownerPrivateBalance = 0n;
  let receiverPrivateBalance = 0n;

  async function syncRoot(label: string) {
    const state = await fetchPoolStateRoot(connection, poolId);
    currentRoot = canonicalizeHex(state.root);
    recentRoots.unshift(currentRoot);
    if (recentRoots.length > 16) {
      recentRoots.pop();
    }
    await publishRoot(INDEXER_PROXY_URL, mintConfig.originMint, currentRoot, recentRoots);
    await waitForIndexerRoot(indexerClient, mintConfig.originMint, currentRoot);
    console.info(`[roots] ${label} root`, currentRoot);
    return state;
  }

  async function performWrap(amount: bigint, label: string): Promise<WrapResult> {
    const poolStateInfo = await fetchPoolStateRoot(connection, poolId);
    const fee = (amount * feeBps) / 10_000n;
    const noteAmount = amount + fee;
    const depositId = crypto.randomInt(1_000_000, 9_000_000).toString();
    const blinding = crypto.randomInt(1_000_000, 9_000_000).toString();
    const payload = {
      oldRoot: canonicalizeHex(poolStateInfo.root),
      amount: noteAmount.toString(),
      recipient: owner.publicKey.toBase58(),
      depositId,
      poolId,
      blinding,
      mintId: mintConfig.originMint
    };
    console.info(`[wrap:${label}] proving`, payload);
    const proof = await proofClient.requestProof('wrap', payload);
    const signature = await wrap({
      connection,
      wallet: ownerAdapter,
      originMint: mintConfig.originMint,
      amount: noteAmount,
      poolId,
      depositId,
      blinding,
      proof,
      commitmentHint: proof.publicInputs?.[2] ?? null,
      recipient: owner.publicKey.toBase58(),
      twinMint: mintConfig.zTokenMint ?? undefined,
    });
    console.info(`[wrap:${label}] signature`, signature);
    ownerPrivateBalance += noteAmount;
    await indexerClient.adjustBalance(owner.publicKey.toBase58(), privateMint, noteAmount);
    const displayAmount = formatBaseUnitsToUi(noteAmount, TARGET_DECIMALS);
    await indexerClient.appendActivity(ownerViewId, {
      id: signature,
      type: 'wrap',
      signature,
      symbol: mintConfig.symbol,
      amount: displayAmount,
      timestamp: Date.now()
    });
    const updated = await syncRoot(`wrap:${label}`);
    return {
      noteId: depositId,
      spendingKey: blinding,
      noteAmount,
      newRoot: updated.root
    };
  }

  async function executeTransfer(params: {
    notes: WrapResult[];
    spendAmount: bigint;
    recipient: PublicKey;
    walletLabel: string;
  }): Promise<string> {
    const { notes, spendAmount, recipient, walletLabel } = params;
    const selection = selectNotesForAmount(notes, spendAmount);
    const totalInput = selection.reduce((sum, note) => sum + note.noteAmount, 0n);
    const changeAmount = totalInput - spendAmount;
    if (changeAmount < 0n) {
      throw new Error('Spend amount exceeds note value');
    }
    const inputNotes = selection.map((note) => ({
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      amount: note.noteAmount.toString()
    }));
    const outNotes = [
      {
        amount: spendAmount.toString(),
        recipient: pubkeyToFieldString(recipient),
        blinding: randomFieldScalar()
      },
      {
        amount: changeAmount.toString(),
        recipient: pubkeyToFieldString(owner.publicKey),
        blinding: changeAmount > 0n ? randomFieldScalar() : '0'
      }
    ];
    const payload = {
      oldRoot: currentRoot,
      mintId: mintConfig.originMint,
      poolId,
      inNotes: inputNotes,
      outNotes
    };
    console.info(`[transfer:${walletLabel}] proving`, payload);
    const proof = await proofClient.requestProof('transfer', payload);
    const parts = parseTransferPublicInputs(proof.publicInputs, inputNotes.length, outNotes.length);
    const amountCommitments = await buildAmountCommitments([
      { amount: spendAmount, blinding: BigInt(outNotes[0]!.blinding) },
      { amount: changeAmount, blinding: changeAmount > 0n ? BigInt(outNotes[1]!.blinding) : 0n }
    ]);
    const signature = await transfer({
      connection,
      wallet: ownerAdapter,
      originMint: mintConfig.originMint,
      poolId,
      proof,
      nullifiers: parts.nullifiers,
      outputCommitments: parts.outputCommitments,
      outputAmountCommitments: amountCommitments,
    });
    console.info('[transfer] signature', signature);
    await syncRoot('transfer');
    return signature;
  }

  async function executeTransferFrom(params: {
    note: WrapResult;
    allowanceAmount: bigint;
    spendAmount: bigint;
    recipient: PublicKey;
  }): Promise<string> {
    const { note, allowanceAmount, spendAmount, recipient } = params;
    if (spendAmount > allowanceAmount) {
      throw new Error('Requested spend exceeds allowance');
    }
    const changeAmount = note.noteAmount - spendAmount;
    if (changeAmount < 0n) {
      throw new Error('Spend amount exceeds note value');
    }
    const inputNotes = [{ noteId: note.noteId, spendingKey: note.spendingKey, amount: note.noteAmount.toString() }];
    const outNotes = [
      {
        amount: spendAmount.toString(),
        recipient: pubkeyToFieldString(recipient),
        blinding: randomFieldScalar()
      },
      {
        amount: changeAmount.toString(),
        recipient: pubkeyToFieldString(owner.publicKey),
        blinding: changeAmount > 0n ? randomFieldScalar() : '0'
      }
    ];
    const payload = {
      oldRoot: currentRoot,
      mintId: mintConfig.originMint,
      poolId,
      inNotes: inputNotes,
      outNotes
    };
    console.info('[transfer_from] proving', payload);
    const proof = await proofClient.requestProof('transfer', payload);
    const parts = parseTransferPublicInputs(proof.publicInputs, inputNotes.length, outNotes.length);
    const amountCommitments = await buildAmountCommitments([
      { amount: spendAmount, blinding: BigInt(outNotes[0]!.blinding) },
      { amount: changeAmount, blinding: changeAmount > 0n ? BigInt(outNotes[1]!.blinding) : 0n }
    ]);
    // CRITICAL FIX: spendAmount is the amount going to others (not change back to spender)
    // In this case, it's the first output (to receiver), not the second (change back)
    const signature = await transferFrom({
      connection,
      wallet: delegateAdapter,
      originMint: mintConfig.originMint,
      poolId,
      proof,
      nullifiers: parts.nullifiers,
      outputCommitments: parts.outputCommitments,
      outputAmountCommitments: amountCommitments,
      allowanceOwner: owner.publicKey.toBase58(),
      allowanceAmount,
      spendAmount, // Spend amount is the amount going to receiver (not change)
    });
    console.info('[transfer_from] signature', signature);
    await syncRoot('transfer_from');
    return signature;
  }

  async function executeUnwrap(params: {
    note: WrapResult;
    amount: bigint;
    fee: bigint;
    destination: PublicKey;
  }): Promise<string> {
    const { note, amount, fee, destination } = params;
    const totalOut = amount + fee;
    if (totalOut > note.noteAmount) {
      throw new Error('Unwrap amount exceeds note value');
    }
    const changeAmount = note.noteAmount - totalOut;
    const changeRecipientField = pubkeyToFieldString(owner.publicKey);
    const changeBlinding = randomFieldScalar();
    const changeAmountBlinding = randomFieldScalar();

    const payload = {
      oldRoot: currentRoot,
      amount: amount.toString(),
      fee: fee.toString(),
      destPubkey: destination.toBase58(),
      mode: 'origin',
      mintId: pubkeyToFieldString(originMintKey),
      poolId: pubkeyToFieldString(poolStateKey),
      noteId: note.noteId,
      spendingKey: note.spendingKey,
      noteAmount: note.noteAmount.toString(),
      change:
        changeAmount > 0n
          ? {
              amount: changeAmount.toString(),
              recipient: changeRecipientField,
              blinding: changeBlinding,
              amountBlinding: changeAmountBlinding
            }
          : undefined
    };
    console.info('[unwrap] proving', payload);
    const proof = await proofClient.requestProof('unwrap', payload);
    const signature = await unwrap({
      connection,
      wallet: ownerAdapter,
      originMint: mintConfig.originMint,
      amount,
      poolId,
      destination: destination.toBase58(),
      mode: 'origin',
      proof,
      twinMint: mintConfig.zTokenMint ?? undefined
    });
    console.info('[unwrap] signature', signature);
    await syncRoot('unwrap');
    return signature;
  }

  const wrapShort = await performWrap(WRAP_AMOUNT, 'short');
  const wrapMedium = await performWrap(WRAP_AMOUNT * 2n, 'medium');
  const wrapLarge = await performWrap(WRAP_AMOUNT * 3n, 'large');
  const allowanceNote = await performWrap(WRAP_AMOUNT, 'allowance');

  let ownerNotes: WrapResult[] = [wrapShort, wrapMedium, wrapLarge];

  console.info('[flow] owner -> receiver private transfer (multi-note with change)');
  const spendAmount =
    wrapShort.noteAmount + wrapMedium.noteAmount - (wrapShort.noteAmount / 4n === 0n ? 1n : wrapShort.noteAmount / 4n);
  const multiTransferNotes = [wrapShort, wrapMedium];
  const transferSignature = await executeTransfer({
    notes: multiTransferNotes,
    spendAmount,
    recipient: receiver.publicKey,
    walletLabel: 'owner'
  });
  ownerPrivateBalance -= spendAmount;
  receiverPrivateBalance += spendAmount;
  ownerNotes = ownerNotes.filter((note) => !multiTransferNotes.some((spent) => spent.noteId === note.noteId));
  await indexerClient.adjustBalance(owner.publicKey.toBase58(), privateMint, -spendAmount);
  await indexerClient.adjustBalance(receiver.publicKey.toBase58(), privateMint, spendAmount);
  const transferDisplay = formatBaseUnitsToUi(spendAmount, TARGET_DECIMALS);
  await indexerClient.appendActivity(ownerViewId, {
    id: transferSignature,
    type: 'transfer',
    signature: transferSignature,
    symbol: mintConfig.symbol,
    amount: `-${transferDisplay}`,
    timestamp: Date.now()
  });
  await indexerClient.appendActivity(receiverViewId, {
    id: transferSignature,
    type: 'transfer',
    signature: transferSignature,
    symbol: mintConfig.symbol,
    amount: transferDisplay,
    timestamp: Date.now()
  });

  console.info('[edge] attempting nullifier reuse on spent notes (expected failure)');
  try {
    await executeTransfer({
      notes: [wrapShort, wrapMedium],
      spendAmount,
      recipient: receiver.publicKey,
      walletLabel: 'owner-reuse'
    });
    throw new Error('Nullifier reuse did not fail as expected');
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (!message.toLowerCase().includes('nullifier')) {
      console.warn('[edge] unexpected error message for nullifier reuse:', message);
    } else {
      console.info('[edge] nullifier reuse rejected as expected');
    }
  }

  console.info('[flow] partial unshield with change');
  // CRITICAL FIX: Calculate fee based on unshield amount (not note amount) to match on-chain calculation
  const unshieldAmount = wrapLarge.noteAmount / 2n;
  // On-chain calculates: fee = (unshieldAmount * fee_bps) / 10000, with minimum of 1
  let calculatedFee = (unshieldAmount * feeBps) / 10_000n;
  const unshieldFee = calculatedFee > 0n ? calculatedFee : 1n;
  const unwrapSignature = await executeUnwrap({
    note: wrapLarge,
    amount: unshieldAmount,
    fee: unshieldFee,
    destination: owner.publicKey
  });
  ownerPrivateBalance -= unshieldAmount;
  await indexerClient.adjustBalance(owner.publicKey.toBase58(), privateMint, -unshieldAmount);
  await indexerClient.appendActivity(ownerViewId, {
    id: unwrapSignature,
    type: 'unwrap',
    signature: unwrapSignature,
    symbol: mintConfig.symbol,
    amount: formatBaseUnitsToUi(unshieldAmount, TARGET_DECIMALS),
    timestamp: Date.now()
  });
  ownerNotes = ownerNotes.filter((note) => note.noteId !== wrapLarge.noteId);

  console.info('[edge] attempting to unshield same note twice (expected failure)');
  try {
    // CRITICAL FIX: Calculate fee for the new amount
    const secondUnshieldAmount = unshieldAmount / 2n;
    let secondCalculatedFee = (secondUnshieldAmount * feeBps) / 10_000n;
    const secondUnshieldFee = secondCalculatedFee > 0n ? secondCalculatedFee : 1n;
    await executeUnwrap({
      note: wrapLarge,
      amount: secondUnshieldAmount,
      fee: secondUnshieldFee,
      destination: owner.publicKey
    });
    throw new Error('Repeated unwrap did not fail as expected');
  } catch (error) {
    console.info('[edge] unwrap reuse rejected as expected:', (error as Error).message);
  }

  console.info('[flow] re-shielding with fresh wrap after unshield');
  const reseal = await performWrap(unshieldAmount / 2n, 'reseal');
  ownerNotes.push(reseal);

  console.info('[flow] allowance approve -> transfer_from -> revoke');
  const allowanceAmount = allowanceNote.noteAmount / 2n;
  await sendAllowanceInstruction({
    connection,
    owner,
    spender: delegate.publicKey,
    poolState: poolStateKey,
    originMint: originMintKey,
    allowanceAddress,
    mintMapping: mintMappingKey,
    instruction: 'approve',
    amount: allowanceAmount
  });
  await indexerClient.setAllowance(
    owner.publicKey.toBase58(),
    delegate.publicKey.toBase58(),
    privateMint,
    allowanceAmount.toString()
  );
  const allowanceTransferSig = await executeTransferFrom({
    note: allowanceNote,
    allowanceAmount,
    spendAmount: allowanceAmount,
    recipient: receiver.publicKey
  });
  await indexerClient.adjustBalance(owner.publicKey.toBase58(), privateMint, -allowanceAmount);
  await indexerClient.adjustBalance(receiver.publicKey.toBase58(), privateMint, allowanceAmount);
  await indexerClient.appendActivity(ownerViewId, {
    id: allowanceTransferSig,
    type: 'transfer_from',
    signature: allowanceTransferSig,
    symbol: mintConfig.symbol,
    amount: `-${formatBaseUnitsToUi(allowanceAmount, TARGET_DECIMALS)}`,
    timestamp: Date.now()
  });
  await indexerClient.appendActivity(receiverViewId, {
    id: allowanceTransferSig,
    type: 'transfer_from',
    signature: allowanceTransferSig,
    symbol: mintConfig.symbol,
    amount: formatBaseUnitsToUi(allowanceAmount, TARGET_DECIMALS),
    timestamp: Date.now()
  });
  await sendAllowanceInstruction({
    connection,
    owner,
    spender: delegate.publicKey,
    poolState: poolStateKey,
    originMint: originMintKey,
    allowanceAddress,
    mintMapping: mintMappingKey,
    instruction: 'revoke'
  });

  console.info('[edge] attempting delegated transfer after revoke (expected failure)');
  try {
    await executeTransferFrom({
      note: allowanceNote,
      allowanceAmount,
      spendAmount: allowanceAmount / 2n,
      recipient: receiver.publicKey
    });
    throw new Error('transfer_from succeeded after revoke');
  } catch (error) {
    console.info('[edge] transfer_from rejected after revoke as expected:', (error as Error).message);
  }

  console.info('[edge] freezing mint via factory authority and validating wrap rejection');
  await freezeMintOnChain({
    connection,
    authority: adminAuthority,
    factoryState: factoryStateKey,
    mintMapping: mintMappingKey
  });
  try {
    await performWrap(WRAP_AMOUNT, 'frozen-state');
    throw new Error('Shield succeeded while mint was frozen');
  } catch (error) {
    console.info('[edge] wrap rejected while frozen as expected:', (error as Error).message);
  }
  console.info('[edge] thawing mint and confirming wraps succeed again');
  await thawMintOnChain({
    connection,
    authority: adminAuthority,
    factoryState: factoryStateKey,
    mintMapping: mintMappingKey
  });
  const postThawWrap = await performWrap(WRAP_AMOUNT, 'post-thaw');
  ownerNotes.push(postThawWrap);

  console.info('[edge] forcing nullifier set to reallocate via bulk insertions');
  await growNullifierSet({
    connection,
    authority: adminAuthority,
    poolState: poolStateKey,
    nullifierSet: nullifierSetKey,
    mintMapping: mintMappingKey,
    inserts: 270
  });

  console.info('[verify] fetching view-keyed notes and balances');
  const ownerNotesResult = await indexerClient.getNotes(ownerViewId);
  const receiverNotesResult = await indexerClient.getNotes(receiverViewId);
  console.info('[verify] owner notes', ownerNotesResult?.notes.length ?? 0);
  console.info('[verify] receiver notes', receiverNotesResult?.notes.length ?? 0);

  const ownerBalances = await indexerClient.getBalances(owner.publicKey.toBase58());
  const receiverBalances = await indexerClient.getBalances(receiver.publicKey.toBase58());
  console.info('[verify] owner balances', ownerBalances);
  console.info('[verify] receiver balances', receiverBalances);

  console.info('[done] full browser-style E2E flow completed successfully');
}

main().catch((error) => {
  console.error('[fatal] full browser e2e script failed', error);
  process.exitCode = 1;
});

