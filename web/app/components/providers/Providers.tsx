'use client';

import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import { ReactNode } from 'react';
import { theme } from '../../theme';
import { SimulationProvider } from '../simulation/SimulationContext';
import { WalletProvider } from './WalletProvider';

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ChakraProvider theme={theme}>
      <ColorModeScript initialColorMode={theme.config.initialColorMode} />
      <SimulationProvider>
        <WalletProvider>{children}</WalletProvider>
      </SimulationProvider>
    </ChakraProvider>
  );
}
