'use client';

import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import { ReactNode } from 'react';
import { WalletProvider } from './WalletProvider';
import { theme } from '../../theme';

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ChakraProvider theme={theme}>
      <ColorModeScript initialColorMode={theme.config.initialColorMode} />
      <WalletProvider>{children}</WalletProvider>
    </ChakraProvider>
  );
}
