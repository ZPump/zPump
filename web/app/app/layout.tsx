import type { Metadata } from 'next';
import { ReactNode } from 'react';
import './globals.css';
import { Space_Grotesk } from 'next/font/google';
import '@solana/wallet-adapter-react-ui/styles.css';
import { Providers } from '../components/providers/Providers';

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' });

export const metadata: Metadata = {
  title: 'Privacy Twin Factory',
  description: 'Shield SPL tokens into private balances and emerge with confidence.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={spaceGrotesk.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
