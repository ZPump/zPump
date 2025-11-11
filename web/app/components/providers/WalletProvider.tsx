'use client';

import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import type { WalletAdapter } from '@solana/wallet-adapter-base';
import { LedgerWalletAdapter, SolflareWalletAdapter, UnsafeBurnerWalletAdapter } from '@solana/wallet-adapter-wallets';
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack';
import { clusterApiUrl } from '@solana/web3.js';
import { ReactNode, useMemo } from 'react';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_RPC_URL ?? clusterApiUrl('devnet'), []);

  const enableBurner = useMemo(() => process.env.NEXT_PUBLIC_ENABLE_BURNER === 'true', []);

  const wallets = useMemo<WalletAdapter[]>(() => {
    const adapters: WalletAdapter[] = [
      new SolflareWalletAdapter(),
      new BackpackWalletAdapter(),
      new LedgerWalletAdapter()
    ];
    if (enableBurner) {
      adapters.push(new UnsafeBurnerWalletAdapter());
    }
    return adapters;
  }, [enableBurner]);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
