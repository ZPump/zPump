import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { MintConfig } from '../../../config/mints';
import { bootstrapPrivateDevnet } from '../../../scripts/bootstrap-private-devnet';
import { getRepoRoot, resolveRepoPath } from '../../../lib/server/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

export async function GET() {
  const catalog = await readMintCatalog();
  const mints = catalog.map(mapGeneratedMint);
  return NextResponse.json({ mints });
}

interface CreateMintPayload {
  symbol?: string;
  decimals?: number;
}

export async function POST(request: Request) {
  if (!isLocalFaucetMode()) {
    return NextResponse.json({ error: 'mint_registration_disabled' }, { status: 403 });
  }

  if (bootstrapInFlight) {
    return NextResponse.json({ error: 'mint_registration_in_progress' }, { status: 429 });
  }

  let payload: CreateMintPayload;
  try {
    payload = (await request.json()) as CreateMintPayload;
  } catch {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  const symbol = payload.symbol?.trim().toUpperCase();
  const decimals = Number(payload.decimals);

  if (!symbol || symbol.length < 2 || symbol.length > 6) {
    return NextResponse.json({ error: 'invalid_symbol' }, { status: 400 });
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    return NextResponse.json({ error: 'invalid_decimals' }, { status: 400 });
  }

  bootstrapInFlight = true;
  try {
    const existing = await readMintCatalog();
    if (existing.some((entry) => entry.symbol.toUpperCase() === symbol)) {
      return NextResponse.json({ error: 'symbol_exists' }, { status: 409 });
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
      return NextResponse.json({ error: 'mint_creation_failed' }, { status: 500 });
    }

    return NextResponse.json({ mint: mapGeneratedMint(created) });
  } catch (error) {
    console.error('[api/mints] mint registration failed', error);
    return NextResponse.json(
      { error: (error as Error).message ?? 'mint_registration_failed' },
      { status: 500 }
    );
  } finally {
    bootstrapInFlight = false;
  }
}


