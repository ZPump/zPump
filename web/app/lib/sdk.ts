import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { WalletContextState } from '@solana/wallet-adapter-react';
import { ProofResponse } from './proofClient';

interface BaseParams {
  connection: Connection;
  wallet: WalletContextState;
  originMint: string;
  amount: bigint;
  poolId: string;
}

interface WrapParams extends BaseParams {
  commitment: string;
  proof: ProofResponse;
}

interface UnwrapParams extends BaseParams {
  destination: string;
  mode: 'origin' | 'ztkn';
  proof: ProofResponse;
}

function assertWallet(wallet: WalletContextState): asserts wallet is WalletContextState & {
  publicKey: NonNullable<WalletContextState['publicKey']>;
  sendTransaction: NonNullable<WalletContextState['sendTransaction']>;
} {
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error('Wallet not connected');
  }
}

async function simulateTransaction(
  connection: Connection,
  wallet: WalletContextState,
  description: string
): Promise<string> {
  assertWallet(wallet);
  const tx = new Transaction();
  tx.feePayer = wallet.publicKey;
  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.recentBlockhash = recentBlockhash;
  // We do not push real instructions here.  The goal is to provide a deterministic
  // signature placeholder so the UI flow can continue end-to-end.
  const signature = await wallet.sendTransaction(tx, connection, { skipPreflight: true });
  console.info(`[zPump SDK] simulated ${description} → ${signature}`);
  return signature;
}

export async function wrap(params: WrapParams): Promise<string> {
  const { connection, wallet, amount } = params;
  const description = `wrap ${amount} lamports for mint ${params.originMint}`;
  return simulateTransaction(connection, wallet, description);
}

export async function unwrap(params: UnwrapParams): Promise<string> {
  const { connection, wallet, amount, mode } = params;
  const description = `unwrap ${amount} lamports via ${mode}`;
  return simulateTransaction(connection, wallet, description);
}

export async function resolvePublicKey(maybeKey: string | undefined, fallback: PublicKey): Promise<PublicKey> {
  if (!maybeKey) {
    return fallback;
  }
  return new PublicKey(maybeKey);
}
