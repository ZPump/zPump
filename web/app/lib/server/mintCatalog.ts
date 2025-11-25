import fs from 'fs/promises';
import path from 'path';
import type { MintConfig } from '../../config/mints';
import { resolveRepoPath } from './paths';

export interface GeneratedMint {
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
  metadataUri?: string | null;
  isNativeZToken?: boolean;
}

const MINTS_PATH = resolveRepoPath('web', 'app', 'config', 'mints.generated.json');

export async function readMintCatalog(): Promise<GeneratedMint[]> {
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

export async function writeMintCatalog(entries: GeneratedMint[]) {
  await fs.mkdir(path.dirname(MINTS_PATH), { recursive: true });
  await fs.writeFile(MINTS_PATH, JSON.stringify(entries, null, 2));
}

export function mapGeneratedMint(entry: GeneratedMint): MintConfig {
  return {
    symbol: entry.symbol,
    originMint: entry.originMint,
    poolId: entry.poolId,
    zTokenMint: entry.zTokenMint ?? undefined,
    decimals: entry.decimals,
    features: entry.features,
    lookupTable: entry.lookupTable ?? undefined,
    isNativeZToken: entry.isNativeZToken ?? false,
    metadataUri: entry.metadataUri ?? undefined
  };
}


