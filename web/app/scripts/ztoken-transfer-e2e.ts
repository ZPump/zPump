import bs58 from 'bs58';
import crypto from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress
} from '@solana/spl-token';
import type { MintConfig } from '../config/mints';
import { ProofClient } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { wrap, transfer, transferFrom } from '../lib/sdk';
import { deriveViewingKey } from '../lib/wallet/viewingKey';
import { canonicalizeHex, bytesLEToCanonicalHex } from '../lib/onchain/utils';
import { poseidonHashMany } from '../lib/onchain/poseidon';
import { formatBaseUnitsToUi } from '../lib/format';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { POOL_PROGRAM_ID } from '../lib/onchain/programIds';
import { deriveAllowanceAccount } from '../lib/onchain/pdas';

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
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000');
const DELEGATED_TRANSFER_AMOUNT = BigInt(
  process.env.PRIVATE_TRANSFER_FROM_AMOUNT ?? (WRAP_AMOUNT / 4n).toString()
);
const TARGET_DECIMALS = Number(process.env.MINT_DECIMALS ?? '6');

const ZERO_HEX = '0x0000000000000000000000000000000000000000000000000000000000000000';
const APPROVE_ALLOWANCE_DISCRIMINATOR = new Uint8Array([100, 169, 165, 25, 25, 255, 11, 45]);
const REVOKE_ALLOWANCE_DISCRIMINATOR = new Uint8Array([121, 114, 141, 153, 128, 164, 101, 113]);

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

interface TransferProofParts {
  oldRoot: string;
  newRoot: string;
  nullifiers: string[];
  outputCommitments: string[];
}

interface WrapResult {
  noteId: string;
  spendingKey: string;
  noteAmount: bigint;
  newRoot: string;
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

function randomSymbol(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let suffix = '';
  for (let i = 0; i < 2; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `PK${suffix}`;
}

function randomFieldScalar(): string {
  const bytes = crypto.randomBytes(31);
  return BigInt(`0x${bytes.toString('hex')}`).toString();
}

function pubkeyToFieldString(key: PublicKey): string {
  const hex = Buffer.from(key.toBytes()).toString('hex');
  return BigInt(`0x${hex}`).toString();
}

function encodeApproveAllowanceData(amount: bigint): Buffer {
  const buffer = Buffer.alloc(APPROVE_ALLOWANCE_DISCRIMINATOR.length + 8);
  Buffer.from(APPROVE_ALLOWANCE_DISCRIMINATOR).copy(buffer, 0);
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setBigUint64(APPROVE_ALLOWANCE_DISCRIMINATOR.length, amount, true);
  return buffer;
}

function encodeRevokeAllowanceData(): Buffer {
  return Buffer.from(REVOKE_ALLOWANCE_DISCRIMINATOR);
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
  instruction: 'approve' | 'revoke';
  amount?: bigint;
}): Promise<string> {
  const { connection, owner, spender, poolState, originMint, allowanceAddress, instruction, amount = 0n } = params;
  const data = instruction === 'approve' ? encodeApproveAllowanceData(amount) : encodeRevokeAllowanceData();
  const ix = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: allowanceAddress, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: spender, isSigner: false, isWritable: false },
      { pubkey: originMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
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

async function poseidonHexFromValues(values: bigint[]): Promise<string> {
  const hash = await poseidonHashMany(values);
  return `0x${Buffer.from(hash).toString('hex')}`;
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
    async sendTransaction(transaction: Transaction | VersionedTransaction): Promise<string> {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([payer]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
        return signature;
      }
      transaction.partialSign(payer);
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
      return signature;
    },
    async signTransaction(transaction: Transaction) {
      transaction.partialSign(payer);
      return transaction;
    },
    async signAllTransactions(transactions: (Transaction | VersionedTransaction)[]) {
      transactions.forEach((tx) => {
        if (tx instanceof VersionedTransaction) {
          tx.sign([payer]);
        } else {
          tx.partialSign(payer);
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
  const nullifiers = publicInputs.slice(2, 2 + inputCount).map((entry) => canonicalizeHex(entry ?? ZERO_HEX));
  const offset = 2 + inputCount;
  const outputCommitments = publicInputs
    .slice(offset, offset + outputCount)
    .map((entry) => canonicalizeHex(entry ?? ZERO_HEX));
  return { oldRoot, newRoot, nullifiers, outputCommitments };
}

function deriveViewId(secret: Uint8Array): string {
  const viewing = deriveViewingKey(bs58.encode(secret));
  if (!viewing) {
    throw new Error('Failed to derive viewing key');
  }
  return viewing.viewId;
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const indexerClient = new IndexerClient({ baseUrl: INDEXER_PROXY_URL });

  const owner = Keypair.generate();
  const receiver = Keypair.generate();
  const delegate = Keypair.generate();

  const ownerAdapter = createWalletAdapter(owner, connection);
  const delegateAdapter = createWalletAdapter(delegate, connection);

  console.info('[wallet] funding owner/delegate SOL');
  await faucetSol(connection, owner.publicKey);
  await faucetSol(connection, delegate.publicKey);

  const ownerViewId = deriveViewId(owner.secretKey);
  const receiverViewId = deriveViewId(receiver.secretKey);

  const symbol = randomSymbol();
  console.info('[mint] registering new mint', { symbol, decimals: TARGET_DECIMALS });
  await registerMint(symbol, TARGET_DECIMALS);
  const mintConfig = await waitForMint((mint) => mint.symbol.toUpperCase() === symbol.toUpperCase());
  const originMintKey = new PublicKey(mintConfig.originMint);
  const poolId = mintConfig.poolId;
  const privateMint = mintConfig.zTokenMint ?? mintConfig.originMint;
  const poolStateKey = new PublicKey(poolId);
  const allowanceAddress = deriveAllowanceAccount(poolStateKey, owner.publicKey, delegate.publicKey);

  const initialPoolInfo = await fetchPoolStateRoot(connection, poolId);
  const feeBps = BigInt(initialPoolInfo.feeBps);
  const perWrapCost = WRAP_AMOUNT + (WRAP_AMOUNT * feeBps) / 10_000n;
  const wrapsRequired = 3n;
  const totalMintNeeded = perWrapCost * wrapsRequired;
  console.info('[faucet] ensuring origin mint balance', { lamports: totalMintNeeded.toString() });
  await ensureTokenBalance(connection, owner.publicKey, originMintKey, totalMintNeeded);

  let currentRoot = initialPoolInfo.root;
  const recentRoots: string[] = [currentRoot];
  await publishRoot(INDEXER_PROXY_URL, mintConfig.originMint, currentRoot, recentRoots);
  await waitForIndexerRoot(indexerClient, mintConfig.originMint, currentRoot);

  let ownerPrivateBalance = 0n;
  let receiverPrivateBalance = 0n;

  async function syncRoot(label: string) {
    const state = await fetchPoolStateRoot(connection, poolId);
    currentRoot = state.root;
    recentRoots.unshift(currentRoot);
    if (recentRoots.length > 16) {
      recentRoots.pop();
    }
    await publishRoot(INDEXER_PROXY_URL, mintConfig.originMint, currentRoot, recentRoots);
    await waitForIndexerRoot(indexerClient, mintConfig.originMint, currentRoot);
    console.info(`[roots] ${label} root`, currentRoot);
    return state;
  }

  async function performWrap(amount: bigint): Promise<WrapResult> {
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
    console.info('[wrap] requesting proof', payload);
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
      lookupTable: mintConfig.lookupTable
    });
    console.info('[wrap] signature', signature);
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
    const updated = await syncRoot('wrap');
    return {
      noteId: depositId,
      spendingKey: blinding,
      noteAmount,
      newRoot: updated.root
    };
  }

  async function buildAmountCommitments(outputs: { amount: bigint; amountBlinding: bigint }[]): Promise<string[]> {
    const results: string[] = [];
    for (const entry of outputs) {
      results.push(await poseidonHexFromValues([entry.amount, entry.amountBlinding]));
    }
    return results;
  }

  async function executeTransfer(params: {
    notes: WrapResult[];
    spendAmount: bigint;
    recipient: PublicKey;
    wallet: WalletLike;
    walletLabel: string;
  }) {
    const { notes, spendAmount, recipient, wallet, walletLabel } = params;
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
    console.info(`[transfer] proving ${walletLabel}`, payload);
    const proof = await proofClient.requestProof('transfer', payload);
    const parts = parseTransferPublicInputs(proof.publicInputs, inputNotes.length, outNotes.length);
    const amountCommitments = await buildAmountCommitments([
      { amount: spendAmount, amountBlinding: BigInt(outNotes[0]!.blinding) },
      { amount: changeAmount, amountBlinding: changeAmount > 0n ? BigInt(outNotes[1]!.blinding) : 0n }
    ]);
    const signature = await transfer({
      connection,
      wallet,
      originMint: mintConfig.originMint,
      poolId,
      proof,
      nullifiers: parts.nullifiers,
      outputCommitments: parts.outputCommitments,
      outputAmountCommitments: amountCommitments,
      lookupTable: mintConfig.lookupTable
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
  }) {
    const { note, allowanceAmount, spendAmount, recipient } = params;
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
      { amount: spendAmount, amountBlinding: BigInt(outNotes[0]!.blinding) },
      { amount: changeAmount, amountBlinding: changeAmount > 0n ? BigInt(outNotes[1]!.blinding) : 0n }
    ]);
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
      lookupTable: mintConfig.lookupTable
    });
    console.info('[transfer_from] signature', signature);
    await syncRoot('transfer_from');
    return signature;
  }

  console.info('[flow] creating liquidity notes for owner');
  const firstWrap = await performWrap(WRAP_AMOUNT);
  const secondWrap = await performWrap(WRAP_AMOUNT);

  const changePadding = secondWrap.noteAmount / 4n;
  const combinedSpendAmount =
    firstWrap.noteAmount + secondWrap.noteAmount - (changePadding === 0n ? 1n : changePadding);
  if (combinedSpendAmount <= firstWrap.noteAmount) {
    throw new Error('Combined transfer amount must exceed single note to test aggregation.');
  }

  console.info('[flow] owner -> receiver private transfer (multi-note)');
  const transferSignature = await executeTransfer({
    notes: [firstWrap, secondWrap],
    spendAmount: combinedSpendAmount,
    recipient: receiver.publicKey,
    wallet: ownerAdapter,
    walletLabel: 'owner'
  });
  ownerPrivateBalance -= combinedSpendAmount;
  receiverPrivateBalance += combinedSpendAmount;
  await indexerClient.adjustBalance(owner.publicKey.toBase58(), privateMint, -combinedSpendAmount);
  await indexerClient.adjustBalance(receiver.publicKey.toBase58(), privateMint, combinedSpendAmount);
  const transferDisplay = formatBaseUnitsToUi(combinedSpendAmount, TARGET_DECIMALS);
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

  console.info('[flow] wrap allowance note');
  const allowanceWrap = await performWrap(WRAP_AMOUNT);

  console.info('[allowance] setting allowance for delegate');
  const allowanceAmount = DELEGATED_TRANSFER_AMOUNT;
  console.info('[allowance] approving on-chain allowance');
  await sendAllowanceInstruction({
    connection,
    owner,
    spender: delegate.publicKey,
    poolState: poolStateKey,
    originMint: originMintKey,
    allowanceAddress,
    instruction: 'approve',
    amount: allowanceAmount
  });
  const onchainAllowance = await fetchAllowanceAccount(connection, allowanceAddress);
  if (!onchainAllowance || onchainAllowance.amount !== allowanceAmount) {
    throw new Error('On-chain allowance mismatch after approval');
  }
  await indexerClient.setAllowance(
    owner.publicKey.toBase58(),
    delegate.publicKey.toBase58(),
    privateMint,
    allowanceAmount.toString()
  );
  const allowanceEntry = await indexerClient.getAllowance(
    owner.publicKey.toBase58(),
    delegate.publicKey.toBase58(),
    privateMint
  );
  if (!allowanceEntry || BigInt(allowanceEntry.amount) !== allowanceAmount) {
    throw new Error('Failed to record allowance in Photon indexer');
  }

  console.info('[flow] delegate transfer_from to receiver');
  const transferFromSignature = await executeTransferFrom({
    note: allowanceWrap,
    allowanceAmount,
    spendAmount: allowanceAmount,
    recipient: receiver.publicKey
  });
  ownerPrivateBalance -= allowanceAmount;
  receiverPrivateBalance += allowanceAmount;
  await indexerClient.adjustBalance(owner.publicKey.toBase58(), privateMint, -allowanceAmount);
  await indexerClient.adjustBalance(receiver.publicKey.toBase58(), privateMint, allowanceAmount);
  const delegatedDisplay = formatBaseUnitsToUi(allowanceAmount, TARGET_DECIMALS);
  await indexerClient.appendActivity(ownerViewId, {
    id: transferFromSignature,
    type: 'transfer_from',
    signature: transferFromSignature,
    symbol: mintConfig.symbol,
    amount: `-${delegatedDisplay}`,
    timestamp: Date.now()
  });
  await indexerClient.appendActivity(receiverViewId, {
    id: transferFromSignature,
    type: 'transfer_from',
    signature: transferFromSignature,
    symbol: mintConfig.symbol,
    amount: delegatedDisplay,
    timestamp: Date.now()
  });

  const remainingAllowance = await fetchAllowanceAccount(connection, allowanceAddress);
  if (!remainingAllowance || remainingAllowance.amount !== 0n) {
    throw new Error('Allowance should be depleted after transfer_from');
  }
  await indexerClient.setAllowance(
    owner.publicKey.toBase58(),
    delegate.publicKey.toBase58(),
    privateMint,
    '0'
  );

  const ownerBalances = await indexerClient.getBalances(owner.publicKey.toBase58());
  const receiverBalances = await indexerClient.getBalances(receiver.publicKey.toBase58());
  const recordedOwner = BigInt(ownerBalances?.balances?.[privateMint] ?? '0');
  const recordedReceiver = BigInt(receiverBalances?.balances?.[privateMint] ?? '0');
  if (recordedOwner !== ownerPrivateBalance) {
    throw new Error(`Owner private balance mismatch: expected ${ownerPrivateBalance}, got ${recordedOwner}`);
  }
  if (recordedReceiver !== receiverPrivateBalance) {
    throw new Error(
      `Receiver private balance mismatch: expected ${receiverPrivateBalance}, got ${recordedReceiver}`
    );
  }

  const randomView = crypto.randomUUID().replace(/-/g, '');
  const randomActivity = await indexerClient.getActivity(randomView).catch(() => null);
  if (randomActivity && randomActivity.entries.length > 0) {
    throw new Error('Unexpected activity for random view ID');
  }

  console.info('[verify] private balances + allowances verified', {
    owner: owner.publicKey.toBase58(),
    receiver: receiver.publicKey.toBase58(),
    ownerPrivateBalance: ownerPrivateBalance.toString(),
    receiverPrivateBalance: receiverPrivateBalance.toString()
  });
}

main()
  .then(() => {
    console.info('[done] transfer + allowance e2e test completed successfully');
  })
  .catch((error) => {
    console.error('[error]', error);
    process.exit(1);
  });

