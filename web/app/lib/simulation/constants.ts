import { SimTokenDefinition } from './types';
import { MINTS } from '../../config/mints';

export const SOL_TOKEN_ID = 'sol-native';
const STATE_VERSION = 1;

export function getSimulationTokens(): SimTokenDefinition[] {
  const baseTokens: SimTokenDefinition[] = [
    {
      id: SOL_TOKEN_ID,
      symbol: 'SOL',
      displayName: 'Test SOL (simulation)',
      decimals: 9,
      category: 'sol'
    }
  ];

  const mintTokens = MINTS.flatMap<SimTokenDefinition>((mint) => {
    const originToken: SimTokenDefinition = {
      id: mint.originMint,
      symbol: mint.symbol,
      displayName: `${mint.symbol} (origin)`,
      decimals: mint.decimals,
      category: 'origin'
    };

    if (mint.features.zTokenEnabled && mint.zTokenMint) {
      const zToken: SimTokenDefinition = {
        id: mint.zTokenMint,
        symbol: `z${mint.symbol}`,
        displayName: `z${mint.symbol} (private)`,
        decimals: mint.decimals,
        category: 'ztoken',
        pairedOriginMint: mint.originMint
      };

      return [originToken, zToken];
    }

    return [originToken];
  });

  return [...baseTokens, ...mintTokens];
}

export function getStateVersion(): number {
  return STATE_VERSION;
}

