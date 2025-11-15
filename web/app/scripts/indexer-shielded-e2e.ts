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
import { BN, BorshCoder, Idl } from '@coral-xyz/anchor';
import type { MintConfig } from '../config/mints';
import { ProofClient } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { wrap, unwrap } from '../lib/sdk';
import { deriveCommitmentTree, deriveAllowanceAccount } from '../lib/onchain/pdas';
import { POOL_PROGRAM_ID } from '../lib/onchain/programIds';
import { decodeCommitmentTree, commitmentToHex } from '../lib/onchain/commitmentTree';
import { bytesLEToCanonicalHex, canonicalizeHex } from '../lib/onchain/utils';
import { poseidonHashMany } from '../lib/onchain/poseidon';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { deriveViewingKey } from '../lib/wallet/viewingKey';
import { formatBaseUnitsToUi } from '../lib/format';
import poolIdl from '../idl/ptf_pool.json';

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
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000'); // default assumes 6 decimals
const TARGET_DECIMALS = Number(process.env.MINT_DECIMALS ?? '6');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const poolCoder = new BorshCoder(poolIdl as Idl);

interface OnchainAllowance {
  pool: PublicKey;
  owner: PublicKey;
  spender: PublicKey;
  mint: PublicKey;
  amount: bigint;
  updatedAt: bigint;
  bump: number;
}

function randomSymbol(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let suffix = '';
  for (let i = 0; i < 2; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `IDX${suffix}`;
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

async function fetchAllowanceAccount(connection: Connection, address: PublicKey): Promise<OnchainAllowance | null> {
  const account = await connection.getAccountInfo(address, 'confirmed');
  if (!account) {
    return null;
  }
  const buffer = Buffer.from(account.data);
  if (buffer.length < 8 + 32 * 4 + 8 + 8 + 1) {
    return null;
  }
  let offset = 8; // skip discriminator
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
  const data =
    instruction === 'approve'
      ? poolCoder.instruction.encode('approve_allowance', { args: { amount: new BN(amount.toString()) } })
      : poolCoder.instruction.encode('revoke_allowance', { args: {} });
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

async function main() {
  console.info('[wallet] generating new keypair');
  const payer = Keypair.generate();
  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const indexerClient = new IndexerClient({ baseUrl: INDEXER_PROXY_URL });

  const secretBase58 = bs58.encode(payer.secretKey);
  const viewing = deriveViewingKey(secretBase58);
  if (!viewing) {
    throw new Error('Failed to derive viewing key');
  }

  console.info('[wallet] requesting SOL airdrop');
  await faucetSol(connection, payer.publicKey);

  const symbol = randomSymbol();
  console.info('[mint] registering new mint', { symbol, decimals: TARGET_DECIMALS });
  await registerMint(symbol, TARGET_DECIMALS);
  const mintConfig = await waitForMint((mint) => mint.symbol.toUpperCase() === symbol.toUpperCase());
  const decimals = mintConfig.decimals ?? TARGET_DECIMALS;
  console.info('[mint] ready', mintConfig);
  const originMintKey = new PublicKey(mintConfig.originMint);
  const walletAdapter = createWalletAdapter(payer, connection);

  const depositId = crypto.randomInt(1_000_000, 9_000_000).toString();
  const blinding = crypto.randomInt(1_000_000, 9_000_000).toString();

  const poolStateInfo = await fetchPoolStateRoot(connection, mintConfig.poolId);
  const feeBps = BigInt(poolStateInfo.feeBps);
  const feeAmount = (WRAP_AMOUNT * feeBps) / 10_000n;
  const noteAmount = WRAP_AMOUNT + feeAmount;
  console.info('[pool] fee config', { feeBps: poolStateInfo.feeBps, feeLamports: feeAmount.toString() });

  console.info('[faucet] funding origin mint balance', { noteAmount: noteAmount.toString() });
  await ensureTokenBalance(connection, payer.publicKey, originMintKey, noteAmount);

  const poolStateKey = new PublicKey(mintConfig.poolId);
  const roots = await indexerClient.getRoots(mintConfig.originMint);
  const poolRootCanonical = poolStateInfo.root;
  const storedRootCanonical =
    roots?.current && roots.current.length > 0 ? canonicalizeHex(roots.current) : poolRootCanonical;
  const oldRootCanonical =
    storedRootCanonical.toLowerCase() === poolRootCanonical.toLowerCase() ? storedRootCanonical : poolRootCanonical;
  const previousRoots = roots
    ? [roots.current, ...(roots.recent ?? [])].map((entry) => (entry ? canonicalizeHex(entry) : poolRootCanonical))
    : [poolRootCanonical];
  await publishRoot(INDEXER_PROXY_URL, mintConfig.originMint, oldRootCanonical, previousRoots.slice(0, 16));

  console.info('[wrap] requesting proof');
  const wrapPayload = {
    oldRoot: canonicalizeHex(oldRootCanonical),
    amount: noteAmount.toString(),
    recipient: payer.publicKey.toBase58(),
    depositId,
    poolId: mintConfig.poolId,
    blinding,
    mintId: mintConfig.originMint
  };
  const wrapProof = await proofClient.requestProof('wrap', wrapPayload);
  console.info('[wrap] proof inputs', wrapProof.publicInputs);

  const wrapSignature = await wrap({
    connection,
    wallet: walletAdapter,
    originMint: mintConfig.originMint,
    amount: noteAmount,
    poolId: mintConfig.poolId,
    depositId,
    blinding,
    proof: wrapProof,
    commitmentHint: wrapProof.publicInputs?.[2] ?? null,
    recipient: payer.publicKey.toBase58(),
    twinMint: mintConfig.zTokenMint ?? undefined,
    lookupTable: mintConfig.lookupTable
  });
  console.info('[wrap] signature', wrapSignature);

  const wrapDisplayAmount = formatBaseUnitsToUi(noteAmount, decimals);
  await indexerClient.adjustBalance(
    payer.publicKey.toBase58(),
    mintConfig.zTokenMint ?? mintConfig.originMint,
    noteAmount
  );
  await indexerClient.appendActivity(viewing.viewId, {
    id: wrapSignature,
    type: 'wrap',
    signature: wrapSignature,
    symbol: mintConfig.symbol,
    amount: wrapDisplayAmount,
    timestamp: Date.now()
  });

  const updatedPoolStateInfo = await fetchPoolStateRoot(connection, mintConfig.poolId);
  const newRootCanonical = updatedPoolStateInfo.root;
  const updatedRecent = [oldRootCanonical, ...previousRoots.filter((root) => root !== oldRootCanonical)].slice(0, 16);
  await publishRoot(INDEXER_PROXY_URL, mintConfig.originMint, newRootCanonical, updatedRecent);
  await waitForIndexerRoot(indexerClient, mintConfig.originMint, newRootCanonical);

  const allowanceSpender = Keypair.generate();
  const allowanceAddress = deriveAllowanceAccount(poolStateKey, payer.publicKey, allowanceSpender.publicKey);
  const allowanceAmount = WRAP_AMOUNT;
  console.info('[allowance] approving on-chain allowance', {
    owner: payer.publicKey.toBase58(),
    spender: allowanceSpender.publicKey.toBase58(),
    amount: allowanceAmount.toString(),
    address: allowanceAddress.toBase58()
  });
  await sendAllowanceInstruction({
    connection,
    owner: payer,
    spender: allowanceSpender.publicKey,
    poolState: poolStateKey,
    originMint: originMintKey,
    allowanceAddress,
    instruction: 'approve',
    amount: allowanceAmount
  });
  const onchainAllowance = await fetchAllowanceAccount(connection, allowanceAddress);
  if (!onchainAllowance || onchainAllowance.amount !== allowanceAmount) {
    throw new Error('On-chain allowance amount mismatch');
  }
  console.info('[allowance] on-chain allowance account', {
    address: allowanceAddress.toBase58(),
    amount: onchainAllowance.amount.toString()
  });

  await indexerClient.setAllowance(
    payer.publicKey.toBase58(),
    allowanceSpender.publicKey.toBase58(),
    mintConfig.zTokenMint ?? mintConfig.originMint,
    allowanceAmount.toString()
  );
  const allowanceSnapshot = await indexerClient.getAllowance(
    payer.publicKey.toBase58(),
    allowanceSpender.publicKey.toBase58(),
    mintConfig.zTokenMint ?? mintConfig.originMint
  );
  if (!allowanceSnapshot || allowanceSnapshot.amount !== allowanceAmount.toString()) {
    throw new Error('Indexer allowance record mismatch');
  }
  console.info('[allowance] indexer allowance stored', allowanceSnapshot);

  const latestTreeAccount = await connection.getAccountInfo(deriveCommitmentTree(originMintKey), 'confirmed');
  if (!latestTreeAccount) {
    throw new Error('Commitment tree missing after wrap');
  }
  const decodedTree = decodeCommitmentTree(new Uint8Array(latestTreeAccount.data));
  console.info('[wrap] on-chain root', commitmentToHex(decodedTree.currentRoot));

  const noteId = BigInt(depositId);
  const spendingKey = BigInt(blinding);
  const nullifierBytes = await poseidonHashMany([noteId, spendingKey]);
  const nullifierHex = `0x${Buffer.from(nullifierBytes).toString('hex')}`;

  const unwrapPayload = {
    oldRoot: newRootCanonical,
    amount: WRAP_AMOUNT.toString(),
    fee: feeAmount.toString(),
    destPubkey: payer.publicKey.toBase58(),
    mode: 'origin' as const,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    noteId: noteId.toString(),
    noteAmount: noteAmount.toString(),
    spendingKey: spendingKey.toString(),
    nullifier: nullifierHex
  };

  console.info('[unwrap] requesting proof');
  const unwrapProof = await proofClient.requestProof('unwrap', unwrapPayload);
  console.info('[unwrap] proof inputs', unwrapProof.publicInputs);

  const unwrapSignature = await unwrap({
    connection,
    wallet: walletAdapter,
    originMint: mintConfig.originMint,
    amount: WRAP_AMOUNT,
    poolId: mintConfig.poolId,
    destination: payer.publicKey.toBase58(),
    mode: 'origin',
    proof: unwrapProof,
    lookupTable: mintConfig.lookupTable,
    twinMint: mintConfig.zTokenMint
  });
  console.info('[unwrap] signature', unwrapSignature);

  await indexerClient.adjustBalance(
    payer.publicKey.toBase58(),
    mintConfig.zTokenMint ?? mintConfig.originMint,
    -WRAP_AMOUNT
  );
  const unwrapDisplayAmount = formatBaseUnitsToUi(WRAP_AMOUNT, decimals);
  await indexerClient.appendActivity(viewing.viewId, {
    id: unwrapSignature,
    type: 'unwrap',
    signature: unwrapSignature,
    symbol: mintConfig.symbol,
    amount: unwrapDisplayAmount,
    timestamp: Date.now()
  });

  const balances = await indexerClient.getBalances(payer.publicKey.toBase58());
  const privateMint = mintConfig.zTokenMint ?? mintConfig.originMint;
  const privateBalanceRaw = balances?.balances?.[privateMint] ?? '0';
  const privateBalance = BigInt(privateBalanceRaw);
  const expectedBalance = noteAmount - WRAP_AMOUNT;
  console.info('[verify] private balance', { recorded: privateBalance.toString(), expected: expectedBalance.toString() });
  if (privateBalance !== expectedBalance) {
    throw new Error(`Private balance mismatch: expected ${expectedBalance}, got ${privateBalance}`);
  }

  const activity = await indexerClient.getActivity(viewing.viewId);
  const signatures = new Set(activity?.entries?.map((entry) => entry.signature));
  if (!signatures.has(wrapSignature) || !signatures.has(unwrapSignature)) {
    throw new Error('Indexer activity log missing wrap or unwrap entries');
  }

  console.info('[allowance] revoking on-chain allowance after transfer simulation');
  await sendAllowanceInstruction({
    connection,
    owner: payer,
    spender: allowanceSpender.publicKey,
    poolState: poolStateKey,
    originMint: originMintKey,
    allowanceAddress,
    instruction: 'revoke'
  });
  const revokedAllowance = await fetchAllowanceAccount(connection, allowanceAddress);
  if (!revokedAllowance || revokedAllowance.amount !== 0n) {
    throw new Error('Allowance revoke failed on-chain');
  }
  await indexerClient.setAllowance(
    payer.publicKey.toBase58(),
    allowanceSpender.publicKey.toBase58(),
    mintConfig.zTokenMint ?? mintConfig.originMint,
    '0'
  );

  console.info('[verify] indexer balances and history verified', {
    wallet: payer.publicKey.toBase58(),
    viewId: viewing.viewId,
    remainingPrivateBalance: privateBalance.toString()
  });
}

main()
  .then(() => {
    console.info('[done] indexer shield/unshield test completed successfully');
  })
  .catch((error) => {
    console.error('[error]', error);
    process.exit(1);
  });


