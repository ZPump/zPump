import fs from 'fs';
import crypto from 'crypto';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress
} from '@solana/spl-token';
import { wrap } from '../lib/sdk';
import { ProofClient } from '../lib/proofClient';
import { IndexerClient } from '../lib/indexerClient';
import { getMintConfig } from '../config/mints';
import { derivePoolState } from '../lib/onchain/pdas';

const SECRET_PATH = process.env.ZPUMP_TEST_WALLET ?? '/tmp/zpump-test.json';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:3000/api/proof';
const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:3000/api/indexer';
const ORIGIN_MINT = process.env.ORIGIN_MINT ?? '3TmFEUDmXP2MVRMEv1bW2gcMz9t8o8jaUYzXRfKVe2qS';
const AMOUNT = process.env.WRAP_AMOUNT ?? '1000000';

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

  const depositId = (crypto.randomInt(1_000_000, 9_000_000)).toString();
  const blinding = (crypto.randomInt(1_000_000, 9_000_000)).toString();

  const depositorTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(ORIGIN_MINT),
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const depoInfo = await connection.getAccountInfo(depositorTokenAccount);
  if (!depoInfo) {
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        depositorTokenAccount,
        payer.publicKey,
        new PublicKey(ORIGIN_MINT),
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    ataTx.feePayer = payer.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    ataTx.recentBlockhash = blockhash;
    ataTx.partialSign(payer);
    const ataSig = await connection.sendRawTransaction(ataTx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: ataSig, blockhash, lastValidBlockHeight }, 'confirmed');
  }

  const roots = await indexerClient.getRoots(ORIGIN_MINT);
  const poolKey = derivePoolState(new PublicKey(ORIGIN_MINT));
  const poolAccount = await connection.getAccountInfo(poolKey);
  if (!poolAccount) {
    throw new Error('Pool state account missing');
  }
  const poolData = Buffer.from(poolAccount.data);
  const currentRootOffset = 8 + 32 * 8; // discriminator + eight 32-byte fields before current_root
  const poolCurrentRootRaw = poolData.slice(currentRootOffset, currentRootOffset + 32);
  const onChainRoot = `0x${poolCurrentRootRaw.toString('hex')}`;

  let oldRoot = roots?.current ?? null;
  if (!oldRoot || oldRoot.toLowerCase() !== onChainRoot.toLowerCase()) {
    oldRoot = onChainRoot;
  }

  const payload = {
    oldRoot,
    amount: AMOUNT,
    recipient: payer.publicKey.toBase58(),
    depositId,
    poolId: mintConfig.poolId,
    blinding,
    mintId: ORIGIN_MINT
  };

  console.log('Requesting shield proof...', payload);
  const proof = await proofClient.requestProof('wrap', payload);
  console.log('Proof received', proof.verifyingKeyHash);
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    console.log('[wrap-local] public inputs', proof.publicInputs);
  }

  const walletAdapter: any = {
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
    sendTransaction: async (transaction: Transaction) => {
      transaction.partialSign(payer);
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false
      });
      return signature;
    },
    signTransaction: async (transaction: Transaction) => {
      transaction.partialSign(payer);
      return transaction;
    },
    signAllTransactions: async (transactions: Transaction[]) => {
      return transactions.map((tx) => {
        tx.partialSign(payer);
        return tx;
      });
    }
  };

  const signature = await wrap({
    connection,
    wallet: walletAdapter,
    originMint: ORIGIN_MINT,
    amount: BigInt(AMOUNT),
    poolId: mintConfig.poolId,
    depositId,
    blinding,
    proof,
    commitmentHint: proof.publicInputs?.[2] ?? null,
    recipient: payer.publicKey.toBase58(),
    twinMint: mintConfig.zTokenMint ?? undefined
  });

  console.log('Wrap transaction signature', signature);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
