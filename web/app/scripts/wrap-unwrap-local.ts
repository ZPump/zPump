import fs from 'fs';
import crypto from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress
} from '@solana/spl-token';
import { ProofClient } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { getMintConfig } from '../config/mints';
import { wrap, unwrap } from '../lib/sdk';
import { deriveCommitmentTree } from '../lib/onchain/pdas';
import { decodeCommitmentTree, commitmentToHex } from '../lib/onchain/commitmentTree';
import { poseidonHashMany } from '../lib/onchain/poseidon';

type WalletLike = Parameters<typeof wrap>[0]['wallet'];

const SECRET_PATH = process.env.ZPUMP_TEST_WALLET ?? '/tmp/zpump-test.json';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:3000/api/proof';
const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:3000/api/indexer';
const FAUCET_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:3000/api/faucet';
const ORIGIN_MINT = process.env.ORIGIN_MINT ?? 'Aw5iYNvtWZuTUJ4k5pfJ3Mtf7QrQcPJ6uK4XV9AhaSBm';
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000'); // 1 USDC (6 decimals)

const SOL_AIRDROP_AMOUNT = 2n * 10n ** 9n;
const MIN_SOL_BALANCE = 1n * 10n ** 9n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bytesToHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;

function randomField(): bigint {
  const bytes = crypto.randomBytes(32);
  return BigInt(`0x${bytes.toString('hex')}`);
}

function toCanonicalHex(leHex: string): string {
  const body = leHex.startsWith('0x') ? leHex.slice(2) : leHex;
  const reversed = Buffer.from(body, 'hex').reverse();
  return `0x${reversed.toString('hex')}`;
}

function toLittleEndianHex(beHex: string): string {
  const body = beHex.startsWith('0x') ? beHex.slice(2) : beHex;
  const reversed = Buffer.from(body, 'hex').reverse();
  return `0x${reversed.toString('hex')}`;
}

async function ensureSolBalance(connection: Connection, owner: PublicKey) {
  const balance = BigInt(await connection.getBalance(owner, 'confirmed'));
  if (balance >= MIN_SOL_BALANCE) {
    return;
  }
  const sig = await connection.requestAirdrop(owner, Number(SOL_AIRDROP_AMOUNT));
  await connection.confirmTransaction(sig, 'confirmed');
}

async function requestFaucetTokens(recipient: PublicKey, mint: PublicKey, amount: bigint) {
  const fetchImpl = globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this environment');
  }
  const response = await fetchImpl(`${FAUCET_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      recipient: recipient.toBase58(),
      mint: mint.toBase58(),
      amount: amount.toString()
    })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      `Faucet request failed: ${response.status} ${
        (payload as { error?: string }).error ?? response.statusText
      }`
    );
  }
  return response.json();
}

async function ensureTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint
) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const account = await connection.getTokenAccountBalance(ata).catch(() => null);
  const current = account ? BigInt(account.value.amount) : 0n;
  if (current >= amount) {
    return;
  }
  await requestFaucetTokens(owner, mint, amount - current);
  let attempts = 0;
  while (attempts < 20) {
    await sleep(500);
    const updated = await connection.getTokenAccountBalance(ata).catch(() => null);
    const next = updated ? BigInt(updated.value.amount) : 0n;
    if (next >= amount) {
      return;
    }
    attempts += 1;
  }
  throw new Error('Timed out waiting for faucet minting');
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
    async sendTransaction(
      transaction: Transaction | VersionedTransaction
    ): Promise<string> {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([payer]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false
        });
        return signature;
      }
      transaction.partialSign(payer);
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false
      });
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

async function fetchCommitmentRoot(connection: Connection, originMint: PublicKey): Promise<string> {
  const commitmentTreeKey = deriveCommitmentTree(originMint);
  const account = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
  if (!account) {
    throw new Error('Commitment tree account missing');
  }
  const decoded = decodeCommitmentTree(new Uint8Array(account.data));
  return commitmentToHex(decoded.currentRoot);
}

function readPoolStateRoot(buffer: Buffer): string {
  // PoolState layout: discriminator (8) + Pubkey fields. current_root is the 9th 32-byte field.
  const CURRENT_ROOT_OFFSET = 8 + 32 * 8;
  const rootBytes = buffer.slice(CURRENT_ROOT_OFFSET, CURRENT_ROOT_OFFSET + 32);
  return `0x${rootBytes.toString('hex')}`;
}

async function fetchPoolStateRoot(connection: Connection, poolId: string): Promise<string> {
  const poolKey = new PublicKey(poolId);
  const account = await connection.getAccountInfo(poolKey, 'confirmed');
  if (!account) {
    throw new Error('Pool state account missing');
  }
  return readPoolStateRoot(Buffer.from(account.data));
}

async function waitForIndexerRoot(
  indexerClient: IndexerClient,
  originMint: string,
  expectRoot: string
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const roots = await indexerClient.getRoots(originMint);
    if (roots) {
      const known = new Set([roots.current, ...roots.recent]);
      if (known.has(expectRoot)) {
        return;
      }
    }
    await sleep(1000);
  }
  throw new Error('Indexer did not return expected root');
}

async function publishRoot(
  baseUrl: string,
  mint: string,
  current: string,
  recent: string[]
): Promise<void> {
  const fetchImpl = globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this environment');
  }
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${normalizedBase}/roots/${mint}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ current, recent })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to publish root: ${response.status} ${
        (payload as { error?: string }).error ?? response.statusText
      }`
    );
  }
}

async function main() {
  const secret = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8')) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(RPC_URL, 'confirmed');
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const indexerClient = new IndexerClient({ baseUrl: INDEXER_URL });
  const mintConfig = getMintConfig(ORIGIN_MINT);
  if (!mintConfig) {
    throw new Error(`Mint config not found for ${ORIGIN_MINT}`);
  }
  const originMintKey = new PublicKey(mintConfig.originMint);

  console.info('[setup] ensuring balances');
  await ensureSolBalance(connection, payer.publicKey);
  await ensureTokenBalance(connection, payer.publicKey, originMintKey, WRAP_AMOUNT);

  const wallet = createWalletAdapter(payer, connection);

  const depositId = crypto.randomInt(1_000_000, 9_000_000).toString();
  const blinding = crypto.randomInt(1_000_000, 9_000_000).toString();

  const roots = await indexerClient.getRoots(mintConfig.originMint);
  const poolRoot = await fetchPoolStateRoot(connection, mintConfig.poolId);
  const poolRootCanonical = toCanonicalHex(poolRoot);
  const storedRootCanonical =
    roots?.current && roots.current.length > 0 ? roots.current : poolRootCanonical;
  const oldRootCanonical =
    storedRootCanonical.toLowerCase() === poolRootCanonical.toLowerCase()
      ? storedRootCanonical
      : poolRootCanonical;
  const previousRoots = roots
    ? [roots.current, ...roots.recent].map((entry) => (entry ? entry : poolRootCanonical))
    : [poolRootCanonical];
  await publishRoot(
    INDEXER_URL,
    mintConfig.originMint,
    oldRootCanonical,
    previousRoots.slice(0, 16)
  );

  const wrapPayload = {
    oldRoot: oldRootCanonical,
    amount: WRAP_AMOUNT.toString(),
    recipient: payer.publicKey.toBase58(),
    depositId,
    poolId: mintConfig.poolId,
    blinding,
    mintId: mintConfig.originMint
  };

  console.info('[wrap] requesting proof');
  const wrapProof = await proofClient.requestProof('wrap', wrapPayload);

  console.info('[wrap] submitting transaction');
  const wrapSignature = await wrap({
    connection,
    wallet,
    originMint: mintConfig.originMint,
    amount: WRAP_AMOUNT,
    poolId: mintConfig.poolId,
    depositId,
    blinding,
    proof: wrapProof,
    commitmentHint: wrapProof.publicInputs?.[2] ?? null,
    recipient: payer.publicKey.toBase58(),
    twinMint: mintConfig.zTokenMint ?? undefined
  });
  console.info('[wrap] confirmed signature', wrapSignature);

  const newRootLe = await fetchCommitmentRoot(connection, originMintKey);
  const newRootCanonical = toCanonicalHex(newRootLe);
  const updatedRecent = [
    oldRootCanonical,
    ...previousRoots.filter((root) => root !== oldRootCanonical)
  ].slice(0, 16);
  await publishRoot(INDEXER_URL, mintConfig.originMint, newRootCanonical, updatedRecent);
  try {
    await waitForIndexerRoot(indexerClient, mintConfig.originMint, newRootCanonical);
  } catch (error) {
    console.warn('[wrap] indexer root not updated', (error as Error).message);
  }
  console.info('[wrap] commitment tree root', newRootCanonical);

  const noteId = randomField();
  const spendingKey = randomField();
  const nullifierBytes = await poseidonHashMany([noteId, spendingKey]);
  const nullifierHex = bytesToHex(nullifierBytes);

  const unshieldPayload = {
    oldRoot: newRootCanonical,
    amount: WRAP_AMOUNT.toString(),
    fee: '0',
    destPubkey: payer.publicKey.toBase58(),
    mode: 'origin' as const,
    mintId: mintConfig.originMint,
    poolId: mintConfig.poolId,
    noteId: noteId.toString(),
    noteAmount: WRAP_AMOUNT.toString(),
    spendingKey: spendingKey.toString(),
    nullifier: nullifierHex
  };

  console.info('[unwrap] requesting proof');
  const unshieldProof = await proofClient.requestProof('unwrap', unshieldPayload);

  console.info('[unwrap] submitting transaction');
  const unwrapSignature = await unwrap({
    connection,
    wallet,
    originMint: mintConfig.originMint,
    amount: WRAP_AMOUNT,
    poolId: mintConfig.poolId,
    destination: payer.publicKey.toBase58(),
    mode: 'origin',
    proof: unshieldProof,
    lookupTable: mintConfig.lookupTable,
    twinMint: mintConfig.zTokenMint
  });

  console.info('[unwrap] confirmed signature', unwrapSignature);
  console.info('[done] wrap and unwrap flow completed successfully');
}

main().catch((error) => {
  console.error('[error]', error);
  process.exit(1);
});

