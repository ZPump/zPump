export interface MintConfig {
  symbol: string;
  originMint: string;
  zTokenMint?: string;
  poolId: string;
  decimals: number;
  features: {
    zTokenEnabled: boolean;
    wrappedTransfers: boolean;
  };
}

export const MINTS: MintConfig[] = [
  {
    symbol: 'USDC',
    originMint: 'Mint111111111111111111111111111111111111111',
    poolId: 'Pool111111111111111111111111111111111111111',
    decimals: 6,
    features: {
      zTokenEnabled: false,
      wrappedTransfers: false
    }
  },
  {
    symbol: 'SOLx',
    originMint: 'Mint222222222222222222222222222222222222222',
    zTokenMint: 'zMint22222222222222222222222222222222222222',
    poolId: 'Pool222222222222222222222222222222222222222',
    decimals: 9,
    features: {
      zTokenEnabled: true,
      wrappedTransfers: false
    }
  }
];

export function getMintConfig(originMint: string): MintConfig | undefined {
  return MINTS.find((mint) => mint.originMint === originMint);
}
