import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress
} from '@solana/spl-token';

let cachedAuthority: { keypair: Keypair; path: string } | null = null;

function getConfig() {
  const mode =
    process.env.FAUCET_MODE ??
    process.env.NEXT_PUBLIC_FAUCET_MODE ??
    'local';
  const rpcUrl = process.env.FAUCET_RPC_URL ?? process.env.RPC_URL ?? 'http://127.0.0.1:8899';
  const keypairPath =
    process.env.FAUCET_KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
  return { mode, rpcUrl, keypairPath };
}

export function assertFaucetEnabled(): void {
  if (getConfig().mode !== 'local') {
    throw new Error('Faucet is disabled on this environment.');
  }
}

export function createFaucetConnection(): Connection {
  return new Connection(getConfig().rpcUrl, 'confirmed');
}

async function loadAuthority(): Promise<Keypair> {
  const { keypairPath } = getConfig();
  if (cachedAuthority && cachedAuthority.path === keypairPath) {
    return cachedAuthority.keypair;
  }
  const raw = await fs.readFile(keypairPath, 'utf8');
  const secret = JSON.parse(raw) as number[];
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  cachedAuthority = { keypair, path: keypairPath };
  return keypair;
}

export async function requestAirDrop(
  connection: Connection,
  recipient: PublicKey,
  lamports: bigint
): Promise<string> {
  if (lamports <= 0n) {
    throw new Error('Lamport amount must be positive.');
  }
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Lamport amount exceeds safe range.');
  }
  const amount = Number(lamports);
  const signature = await connection.requestAirdrop(recipient, amount);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await pollForConfirmation(connection, signature, { blockhash, lastValidBlockHeight });
  return signature;
}

export async function mintTokensToOwner(
  connection: Connection,
  recipient: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<string> {
  if (amount <= 0n) {
    throw new Error('Mint amount must be positive.');
  }
  const authority = await loadAuthority();
  const ata = await getAssociatedTokenAddress(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const instructions: TransactionInstruction[] = [];
  const accountInfo = await connection.getAccountInfo(ata);
  if (!accountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        ata,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  instructions.push(
    createMintToInstruction(mint, ata, authority.publicKey, amount, undefined, TOKEN_PROGRAM_ID)
  );

  return sendInstructions(connection, authority, instructions);
}

async function sendInstructions(
  connection: Connection,
  signer: Keypair,
  instructions: TransactionInstruction[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: blockhash
  });
  for (const instruction of instructions) {
    transaction.add(instruction);
  }
  transaction.sign(signer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true
  });
  await pollForConfirmation(connection, signature, { blockhash, lastValidBlockHeight });
  return signature;
}

async function pollForConfirmation(
  connection: Connection,
  signature: string,
  base: { blockhash: string; lastValidBlockHeight: number }
) {
  const start = Date.now();
  const timeoutMs = 45_000;
  const pollInterval = 1_500;
  for (;;) {
    const result = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = result.value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    const currentBlockHeight = await connection.getBlockHeight('confirmed');
    if (currentBlockHeight > base.lastValidBlockHeight) {
      throw new Error('Transaction expired before confirmation.');
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Transaction confirmation timed out.');
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}


