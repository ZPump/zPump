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

const FAUCET_MODE = process.env.FAUCET_MODE ?? 'disabled';
const DEFAULT_RPC_URL = process.env.FAUCET_RPC_URL ?? process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const KEYPAIR_PATH =
  process.env.FAUCET_KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json');

let cachedAuthority: Keypair | null = null;

export function assertFaucetEnabled(): void {
  if (FAUCET_MODE !== 'local') {
    throw new Error('Faucet is disabled on this environment.');
  }
}

export function createFaucetConnection(): Connection {
  return new Connection(DEFAULT_RPC_URL, 'confirmed');
}

async function loadAuthority(): Promise<Keypair> {
  if (cachedAuthority) {
    return cachedAuthority;
  }
  const raw = await fs.readFile(KEYPAIR_PATH, 'utf8');
  const secret = JSON.parse(raw) as number[];
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  cachedAuthority = keypair;
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
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
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
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}


