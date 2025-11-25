import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import type { MintConfig } from '../../config/mints';
import { bootstrapPrivateDevnet } from '../../scripts/bootstrap-private-devnet';
import { getRepoRoot, resolveRepoPath } from '../../lib/server/paths';

interface GeneratedMint {
  symbol: string;
  decimals: number;
  originMint: string;
  poolId: string;
  zTokenMint: string | null;
  features: {
    zTokenEnabled: boolean;
    wrappedTransfers: boolean;
  };
  lookupTable?: string | null;
}

const PROJECT_ROOT = getRepoRoot();
const MINTS_PATH = resolveRepoPath('web', 'app', 'config', 'mints.generated.json');
const PLACEHOLDER_ORIGIN = 'Mint111111111111111111111111111111111111111';
const PLACEHOLDER_POOL = 'Pool111111111111111111111111111111111111111';

let bootstrapInFlight = false;

function isLocalFaucetMode(): boolean {
  const mode = process.env.FAUCET_MODE ?? process.env.NEXT_PUBLIC_FAUCET_MODE ?? 'local';
  return mode === 'local';
}

function mapGeneratedMint(entry: GeneratedMint): MintConfig {
  return {
    symbol: entry.symbol,
    originMint: entry.originMint,
    poolId: entry.poolId,
    zTokenMint: entry.zTokenMint ?? undefined,
    decimals: entry.decimals,
    features: entry.features,
    lookupTable: entry.lookupTable ?? undefined
  };
}

async function readMintCatalog(): Promise<GeneratedMint[]> {
  try {
    const raw = await fs.readFile(MINTS_PATH, 'utf8');
    return JSON.parse(raw) as GeneratedMint[];
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeMintCatalog(entries: GeneratedMint[]) {
  await fs.mkdir(path.dirname(MINTS_PATH), { recursive: true });
  await fs.writeFile(MINTS_PATH, JSON.stringify(entries, null, 2));
}

async function handleGet(res: NextApiResponse) {
  const catalog = (await readMintCatalog()).filter(
    (entry) =>
      entry.originMint !== PLACEHOLDER_ORIGIN && entry.poolId !== PLACEHOLDER_POOL
  );
  const mints = catalog.map(mapGeneratedMint);
  res.status(200).json({ mints });
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  if (!isLocalFaucetMode()) {
    res.status(403).json({ error: 'mint_registration_disabled' });
    return;
  }
  if (bootstrapInFlight) {
    res.status(429).json({ error: 'mint_registration_in_progress' });
    return;
  }
  let payload: { symbol?: string; decimals?: number };
  try {
    payload = req.body as { symbol?: string; decimals?: number };
  } catch {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }
  const symbol = payload.symbol?.trim().toUpperCase();
  const decimals = Number(payload.decimals);
  if (!symbol || symbol.length < 2 || symbol.length > 6) {
    res.status(400).json({ error: 'invalid_symbol' });
    return;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    res.status(400).json({ error: 'invalid_decimals' });
    return;
  }

  bootstrapInFlight = true;
  try {
    const existing = await readMintCatalog();
    if (existing.some((entry) => entry.symbol.toUpperCase() === symbol)) {
      res.status(409).json({ error: 'symbol_exists' });
      return;
    }
    existing.push({
      symbol,
      decimals,
      originMint: PLACEHOLDER_ORIGIN,
      poolId: PLACEHOLDER_POOL,
      zTokenMint: null,
      features: {
        zTokenEnabled: true,
        wrappedTransfers: false
      },
      lookupTable: null
    });
    await writeMintCatalog(existing);

    await bootstrapPrivateDevnet();

    const refreshed = await readMintCatalog();
    const created = refreshed.find((entry) => entry.symbol.toUpperCase() === symbol);
    if (!created) {
      res.status(500).json({ error: 'mint_creation_failed' });
      return;
    }
    res.status(200).json({ mint: mapGeneratedMint(created) });
  } catch (error) {
    const errorMessage = (error as Error).message ?? 'mint_registration_failed';
    const errorStack = (error as Error).stack ?? '';
    console.error('[api/mints] mint registration failed', {
      message: errorMessage,
      stack: errorStack,
      error: error
    });
    
    // Provide more helpful error messages for common issues
    let statusCode = 500;
    let errorResponse = errorMessage;
    
    if (errorMessage.includes('0x0') || errorMessage.includes('custom program error: 0x0')) {
      // Log the full error for debugging
      console.error('[api/mints] 0x0 error details:', {
        fullError: String(error),
        message: errorMessage,
        stack: errorStack
      });
      errorResponse = `Account already exists in uninitialized state. Full error: ${errorMessage}`;
      statusCode = 409; // Conflict
    } else if (errorMessage.includes('InvalidMintFormat') || errorMessage.includes('Invalid mint format')) {
      errorResponse = 'Mint account is in an invalid state. The mint_mapping account may exist but be owned by the wrong program. Try using a different mint.';
      statusCode = 400;
    } else if (errorMessage.includes('AlreadyRegistered')) {
      errorResponse = 'This mint is already registered.';
      statusCode = 409;
    } else if (errorMessage.includes('Cannot register mint') && errorMessage.includes('uninitialized')) {
      // This is our check failing - the mint_mapping is uninitialized
      errorResponse = errorMessage;
      statusCode = 400;
    }
    
    res.status(statusCode).json({
      error: errorResponse
    });
  } finally {
    bootstrapInFlight = false;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      await handleGet(res);
      return;
    }
    if (req.method === 'POST') {
      await handlePost(req, res);
      return;
    }
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end('Method Not Allowed');
  } catch (error) {
    console.error('[api/mints] unexpected failure', error);
    res.status(500).json({ error: 'internal_error' });
  }
}

