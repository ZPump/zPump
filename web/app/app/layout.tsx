import type { Metadata } from 'next';
import { ReactNode } from 'react';
import './globals.css';
import { Space_Grotesk } from 'next/font/google';
import '@solana/wallet-adapter-react-ui/styles.css';
import { Providers } from '../components/providers/Providers';

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' });

export const metadata: Metadata = {
  title: 'zPump',
  description: 'Wrap SPL tokens into zk-proof-backed zTokens and move liquidity with privacy.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} chakra-ui-dark`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
