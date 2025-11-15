'use client';

import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import { ReactNode, useEffect } from 'react';
import { theme } from '../../theme';
import { WalletProvider } from './WalletProvider';
import { MintCatalogProvider } from './MintCatalogProvider';

interface ProvidersProps {
  children: ReactNode;
}

function StorageResetter() {
  useEffect(() => {
    try {
      const STORAGE_RESET_KEY = 'zpump:storage-reset-token';
      const resetToken = process.env.NEXT_PUBLIC_STORAGE_RESET_TOKEN ?? '2025-11-15-reset';
      const currentToken = window.localStorage.getItem(STORAGE_RESET_KEY);
      if (currentToken !== resetToken) {
        window.localStorage.clear();
        window.localStorage.setItem(STORAGE_RESET_KEY, resetToken);
      }
    } catch (error) {
      console.warn('[storage] unable to reset localStorage', error);
    }
  }, []);
  return null;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ChakraProvider theme={theme}>
      <ColorModeScript initialColorMode={theme.config.initialColorMode} />
      <MintCatalogProvider>
        <WalletProvider>
          <StorageResetter />
          {children}
        </WalletProvider>
      </MintCatalogProvider>
    </ChakraProvider>
  );
}
