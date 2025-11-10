import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { Providers } from '../components/providers/Providers';
import './globals.css';
import '@solana/wallet-adapter-react-ui/styles.css';
import { ColorModeScript } from '@chakra-ui/react';
import { theme } from '../theme';
import { Space_Grotesk } from 'next/font/google';

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' });

export const metadata: Metadata = {
  title: 'Privacy Twin Factory',
  description: 'Shield SPL tokens into private balances and emerge with confidence.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={spaceGrotesk.variable}>
      <body>
        <ColorModeScript initialColorMode={theme.config.initialColorMode} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
