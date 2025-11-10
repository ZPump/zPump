export interface MintConfig {
  symbol: string;
  originMint: string;
  poolId: string;
  decimals: number;
  features: {
    twinEnabled: boolean;
    privateTransfers: boolean;
  };
}

export const MINTS: MintConfig[] = [
  {
    symbol: 'USDC',
    originMint: 'Mint111111111111111111111111111111111111111',
    poolId: 'Pool111111111111111111111111111111111111111',
    decimals: 6,
    features: {
      twinEnabled: false,
      privateTransfers: false
    }
  },
  {
    symbol: 'SOLx',
    originMint: 'Mint222222222222222222222222222222222222222',
    poolId: 'Pool222222222222222222222222222222222222222',
    decimals: 9,
    features: {
      twinEnabled: true,
      privateTransfers: false
    }
  }
];

export function getMintConfig(originMint: string): MintConfig | undefined {
  return MINTS.find((mint) => mint.originMint === originMint);
}
