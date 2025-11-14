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
import { bytesLEToCanonicalHex, canonicalizeHex } from '../lib/onchain/utils';
import { poseidonHashMany } from '../lib/onchain/poseidon';

type WalletLike = Parameters<typeof wrap>[0]['wallet'];

const SECRET_PATH = process.env.ZPUMP_TEST_WALLET ?? '/tmp/zpump-test.json';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:3000/api/proof';
const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:3000/api/indexer';
const FAUCET_URL = process.env.FAUCET_URL ?? 'http://127.0.0.1:3000/api/faucet';
const ORIGIN_MINT = process.env.ORIGIN_MINT ?? 'iq8vG5SBdAZSwgCEME5b4yDqiLydbFciUZ3ZrgCSp4J';
const WRAP_AMOUNT = BigInt(process.env.WRAP_AMOUNT ?? '1000000'); // 1 USDC (6 decimals)

const SOL_AIRDROP_AMOUNT = 2n * 10n ** 9n;
const MIN_SOL_BALANCE = 1n * 10n ** 9n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 30_000
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
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

const bytesToHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;

function randomField(): bigint {
  const bytes = crypto.randomBytes(32);
  return BigInt(`0x${bytes.toString('hex')}`);
}

async function ensureSolBalance(connection: Connection, owner: PublicKey) {
  const balance = BigInt(await connection.getBalance(owner, 'confirmed'));
  if (balance >= MIN_SOL_BALANCE) {
    return;
  }
  const sig = await connection.requestAirdrop(owner, Number(SOL_AIRDROP_AMOUNT));
  await confirmSignature(connection, sig);
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

async function fetchPoolStateRoot(connection: Connection, poolId: string): Promise<{ root: string; feeBps: number }> {
  const poolKey = new PublicKey(poolId);
  const account = await connection.getAccountInfo(poolKey, 'confirmed');
  if (!account) {
    throw new Error('Pool state account missing');
  }
  const buffer = Buffer.from(account.data);
  let offset = 8; // account discriminator

  const advance = (bytes: number) => {
    offset += bytes;
  };

  // Skip authority, origin_mint, vault, verifier_program, verifying_key, commitment_tree
  advance(32 * 6);
  // Skip verifying_key_id and verifying_key_hash
  advance(32); // verifying_key_id
  advance(32); // verifying_key_hash

  const rootBytes = buffer.slice(offset, offset + 32);
  advance(32); // current_root

  // Skip recent_roots
  advance(32 * 16);

  // roots_len (u8)
  offset += 1;

  // Align to 2-byte boundary for fee_bps (u16)
  if (offset % 2 !== 0) {
    offset += 1;
  }

  const feeBps = buffer.readUInt16LE(offset);

  return {
    root: bytesLEToCanonicalHex(rootBytes),
    feeBps
  };
}

async function waitForIndexerRoot(
  indexerClient: IndexerClient,
  originMint: string,
  expectRoot: string
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const roots = await indexerClient.getRoots(originMint);
    if (roots) {
      const known = new Set([roots.current, ...roots.recent].map((entry) => canonicalizeHex(entry)));
      if (known.has(canonicalizeHex(expectRoot))) {
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
    body: JSON.stringify({
      current: canonicalizeHex(current),
      recent: recent.map((entry) => canonicalizeHex(entry))
    })
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

  const wallet = createWalletAdapter(payer, connection);

  const depositId = crypto.randomInt(1_000_000, 9_000_000).toString();
  const blinding = crypto.randomInt(1_000_000, 9_000_000).toString();

  const roots = await indexerClient.getRoots(mintConfig.originMint);
  const poolStateInfo = await fetchPoolStateRoot(connection, mintConfig.poolId);
  const unwrapAmount = WRAP_AMOUNT;
  const feeBpsBig = BigInt(poolStateInfo.feeBps);
  const fee = (unwrapAmount * feeBpsBig) / 10_000n;
  const noteAmount = unwrapAmount + fee;
  if (noteAmount === 0n) {
    throw new Error('Note amount must be greater than zero.');
  }

  console.info('[setup] pool fee config', {
    feeBps: poolStateInfo.feeBps,
    unwrapAmount: unwrapAmount.toString(),
    fee: fee.toString(),
    noteAmount: noteAmount.toString()
  });

  await ensureTokenBalance(connection, payer.publicKey, originMintKey, noteAmount);

  const poolRootCanonical = poolStateInfo.root;
  const storedRootCanonical =
    roots?.current && roots.current.length > 0
      ? canonicalizeHex(roots.current)
      : poolRootCanonical;
  const oldRootCanonical =
    storedRootCanonical.toLowerCase() === poolRootCanonical.toLowerCase()
      ? storedRootCanonical
      : poolRootCanonical;
  const previousRoots = roots
    ? [roots.current, ...roots.recent].map((entry) =>
        entry ? canonicalizeHex(entry) : poolRootCanonical
      )
    : [poolRootCanonical];
  await publishRoot(
    INDEXER_URL,
    mintConfig.originMint,
    oldRootCanonical,
    previousRoots.slice(0, 16)
  );

  const wrapPayload = {
    oldRoot: canonicalizeHex(oldRootCanonical),
    amount: noteAmount.toString(),
    recipient: payer.publicKey.toBase58(),
    depositId,
    poolId: mintConfig.poolId,
    blinding,
    mintId: mintConfig.originMint
  };

  console.info('[wrap] requesting proof');
  const wrapProof = await proofClient.requestProof('wrap', wrapPayload);
  const wrapInputs = wrapProof.publicInputs ?? [];
  console.info('[wrap] public inputs', wrapInputs);
  const proofOldRoot = wrapInputs.length > 0 ? canonicalizeHex(wrapInputs[0]!) : null;
  if (!proofOldRoot || proofOldRoot.toLowerCase() !== oldRootCanonical.toLowerCase()) {
    throw new Error('Wrap proof root mismatch with canonical old root');
  }

  console.info('[wrap] submitting transaction');
  const wrapSignature = await wrap({
    connection,
    wallet,
    originMint: mintConfig.originMint,
    amount: noteAmount,
    poolId: mintConfig.poolId,
    depositId,
    blinding,
    proof: wrapProof,
    commitmentHint: wrapProof.publicInputs?.[2] ?? null,
    recipient: payer.publicKey.toBase58(),
    twinMint: mintConfig.zTokenMint ?? undefined
  });
  console.info('[wrap] confirmed signature', wrapSignature);

  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const treeAccount = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
  let treeRootCanonical: string | null = null;
  if (treeAccount) {
    const rawRoot = decodeCommitmentTree(new Uint8Array(treeAccount.data)).currentRoot;
    treeRootCanonical = bytesLEToCanonicalHex(rawRoot);
    console.info('[wrap] tree raw root', Buffer.from(rawRoot).toString('hex'));
    console.info('[wrap] tree canonical root', treeRootCanonical);
  }
  const updatedPoolStateInfo = await fetchPoolStateRoot(connection, mintConfig.poolId);
  console.info('[wrap] pool state root', updatedPoolStateInfo.root, 'fee bps', updatedPoolStateInfo.feeBps);
  const newRootCanonical = updatedPoolStateInfo.root;
  if (treeRootCanonical && treeRootCanonical.toLowerCase() !== newRootCanonical.toLowerCase()) {
    console.warn('[wrap] tree/pool root mismatch', { treeRootCanonical, poolRootCanonical });
  }
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

  const proofNewRoot = wrapInputs.length > 1 ? canonicalizeHex(wrapInputs[1]!) : null;
  if (!proofNewRoot || proofNewRoot.toLowerCase() !== newRootCanonical.toLowerCase()) {
    console.warn(
      '[wrap] proof supplied new root does not match on-chain root',
      proofNewRoot,
      newRootCanonical
    );
  }

  const noteId = BigInt(depositId);
  const spendingKey = BigInt(blinding);
  const nullifierBytes = await poseidonHashMany([noteId, spendingKey]);
  const nullifierHex = bytesToHex(nullifierBytes);

  const unshieldPayload = {
    oldRoot: newRootCanonical,
    amount: unwrapAmount.toString(),
    fee: fee.toString(),
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
  const unshieldProof = await proofClient.requestProof('unwrap', unshieldPayload);
  console.info('[unwrap] public inputs', unshieldProof.publicInputs);

  console.info('[unwrap] submitting transaction');
  const unwrapSignature = await unwrap({
    connection,
    wallet,
    originMint: mintConfig.originMint,
    amount: unwrapAmount,
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

