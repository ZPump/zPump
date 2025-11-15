export interface MintConfig {
  symbol: string;
  originMint: string;
  poolId: string;
  zTokenMint?: string;
  decimals: number;
  features: {
    zTokenEnabled: boolean;
    wrappedTransfers: boolean;
  };
  lookupTable?: string;
}

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

const DEFAULT_MINTS: GeneratedMint[] = [];

let generated: GeneratedMint[] = DEFAULT_MINTS;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  generated = require('./mints.generated.json') as GeneratedMint[];
} catch {
  // fall back to defaults if generated catalog is missing
}

export const MINTS: MintConfig[] = generated.map((entry) => ({
  symbol: entry.symbol,
  originMint: entry.originMint,
  poolId: entry.poolId,
  zTokenMint: entry.zTokenMint ?? undefined,
  decimals: entry.decimals,
  features: entry.features,
  lookupTable: entry.lookupTable ?? undefined
}));

export function getMintConfig(originMint: string): MintConfig | undefined {
  return MINTS.find((mint) => mint.originMint === originMint);
}
