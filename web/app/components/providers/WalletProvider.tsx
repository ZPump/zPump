'use client';

import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import type { WalletAdapter } from '@solana/wallet-adapter-base';
import { LedgerWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack';
import { clusterApiUrl } from '@solana/web3.js';
import { ReactNode, useMemo } from 'react';
import { ManagedKeypairWalletAdapter } from '../../lib/wallet/ManagedAdapter';
import { LocalWalletProvider } from '../wallet/LocalWalletContext';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const endpoint = useMemo(() => {
    const fallback = 'https://devnet-rpc.zpump.xyz';
    const raw = process.env.NEXT_PUBLIC_RPC_URL ?? fallback;
    try {
      const url = new URL(raw);
      if (
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
        typeof window !== 'undefined'
      ) {
        url.hostname = window.location.hostname;
        return url.toString();
      }
      return url.toString();
    } catch {
      return raw || clusterApiUrl('devnet');
    }
  }, []);

  const managedAdapter = useMemo(() => new ManagedKeypairWalletAdapter(), []);

  const wallets = useMemo<WalletAdapter[]>(() => {
    const adapters: WalletAdapter[] = [
      managedAdapter,
      new SolflareWalletAdapter(),
      new BackpackWalletAdapter(),
      new LedgerWalletAdapter()
    ];
    return adapters;
  }, [managedAdapter]);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <LocalWalletProvider adapter={managedAdapter}>{children}</LocalWalletProvider>
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
