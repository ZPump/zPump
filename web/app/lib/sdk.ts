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

interface ShieldParams extends BaseParams {
  commitment: string;
  proof: ProofResponse;
}

interface UnshieldParams extends BaseParams {
  destination: string;
  mode: 'origin' | 'ptkn';
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
  console.info(`[PTF SDK] simulated ${description} → ${signature}`);
  return signature;
}

export async function shield(params: ShieldParams): Promise<string> {
  const { connection, wallet, amount } = params;
  const description = `shield ${amount} lamports for mint ${params.originMint}`;
  return simulateTransaction(connection, wallet, description);
}

export async function unshield(params: UnshieldParams): Promise<string> {
  const { connection, wallet, amount, mode } = params;
  const description = `unshield ${amount} lamports via ${mode}`;
  return simulateTransaction(connection, wallet, description);
}

export async function resolvePublicKey(maybeKey: string | undefined, fallback: PublicKey): Promise<PublicKey> {
  if (!maybeKey) {
    return fallback;
  }
  return new PublicKey(maybeKey);
}
