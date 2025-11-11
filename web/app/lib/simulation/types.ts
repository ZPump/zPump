export interface SimTokenDefinition {
  id: string;
  symbol: string;
  displayName: string;
  decimals: number;
  category: 'sol' | 'origin' | 'ztoken';
  pairedOriginMint?: string;
}

export interface SimAccount {
  id: string;
  label: string;
  publicKey: string;
  secretKey: string;
  createdAt: number;
  balances: Record<string, string>;
}

export interface SimTransaction {
  id: string;
  from?: string;
  to: string;
  tokenId: string;
  amount: string;
  timestamp: number;
  type: SimTransactionType;
  memo?: string;
}

export interface SimulationState {
  accounts: SimAccount[];
  activeAccountId: string | null;
  transactions: SimTransaction[];
  version: number;
}

export type SimTransactionType = 'mint' | 'transfer' | 'airdrop' | 'shield' | 'unshield';

