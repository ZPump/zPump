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
    const fallback = 'http://127.0.0.1:8899';
    const raw = process.env.NEXT_PUBLIC_RPC_URL ?? fallback;
    try {
      const url = new URL(raw);
      // If RPC URL is localhost/127.0.0.1 and we're on a production domain, use the tunnel
      if (
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
        typeof window !== 'undefined'
      ) {
        const currentHost = window.location.hostname;
        // If we're on alpha.zpump.xyz, use devnet-rpc.zpump.xyz for RPC
        if (currentHost === 'alpha.zpump.xyz' || currentHost.includes('zpump.xyz')) {
          url.hostname = 'devnet-rpc.zpump.xyz';
          url.port = ''; // Remove port, Cloudflare tunnel handles it
          url.protocol = 'https:'; // Cloudflare tunnels use HTTPS
        } else {
          url.hostname = currentHost;
        }
      }
      return url.toString();
    } catch {
      return raw || fallback || clusterApiUrl('devnet');
    }
  }, []);

  if (typeof window !== 'undefined') {
    // eslint-disable-next-line no-console
    console.info('[wallet-provider] using RPC endpoint', endpoint);
  }

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
