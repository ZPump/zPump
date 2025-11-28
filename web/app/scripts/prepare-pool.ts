import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Connection, Keypair } from '@solana/web3.js';
import { preparePool } from '../lib/sdk';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { createWalletAdapter } from './utils/walletAdapter';

ensureFetchPolyfill();

function resolveKeypairPath(): string {
  return process.env.KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
}

async function loadKeypair(filePath: string): Promise<Keypair> {
  const secret = await fs.readFile(filePath, 'utf-8');
  const secretKey = Uint8Array.from(JSON.parse(secret));
  return Keypair.fromSecretKey(secretKey);
}

async function main() {
  const originMint = process.argv[2] ?? process.env.ORIGIN_MINT;
  if (!originMint) {
    console.error('Usage: ts-node scripts/prepare-pool.ts <originMint>');
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
  const connection = new Connection(rpcUrl, 'confirmed');
  const keypairPath = resolveKeypairPath();
  const payer = await loadKeypair(keypairPath);
  const wallet = createWalletAdapter(payer);

  console.info(`[prepare-pool] Using RPC ${rpcUrl}`);
  console.info(`[prepare-pool] Origin mint: ${originMint}`);

  const result = await preparePool({
    connection,
    wallet: wallet as any,
    originMint
  });

  if (result.actions.length === 0) {
    console.info('[prepare-pool] Pool already initialized. No actions required.');
  } else {
    console.info(`[prepare-pool] Initialized components: ${result.actions.join(', ')}`);
  }
}

main().catch((error) => {
  console.error('[prepare-pool] Failed to initialize pool:', error);
  process.exit(1);
});

