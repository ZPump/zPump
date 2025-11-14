'use client';

import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import { ReactNode } from 'react';
import { theme } from '../../theme';
import { WalletProvider } from './WalletProvider';
import { MintCatalogProvider } from './MintCatalogProvider';

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ChakraProvider theme={theme}>
      <ColorModeScript initialColorMode={theme.config.initialColorMode} />
      <MintCatalogProvider>
        <WalletProvider>{children}</WalletProvider>
      </MintCatalogProvider>
    </ChakraProvider>
  );
}
