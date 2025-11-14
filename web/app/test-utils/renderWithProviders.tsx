import { ChakraProvider } from '@chakra-ui/react';
import type { RenderOptions } from '@testing-library/react';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { theme } from '../theme';
import type { MintConfig } from '../config/mints';
import { MINTS } from '../config/mints';
import { MintCatalogProvider } from '../components/providers/MintCatalogProvider';

interface ProvidersProps {
  children: ReactNode;
  initialMints: MintConfig[];
}

function createWrapper(initialMints: MintConfig[]) {
  return function AllProviders({ children }: Omit<ProvidersProps, 'initialMints'>) {
    return (
      <ChakraProvider theme={theme}>
        <MintCatalogProvider initialMints={initialMints}>{children}</MintCatalogProvider>
      </ChakraProvider>
    );
  };
}

interface RenderOptionsWithProviders extends Omit<RenderOptions, 'wrapper'> {
  mintCatalog?: MintConfig[];
}

export function renderWithProviders(ui: ReactElement, options?: RenderOptionsWithProviders) {
  const initialMints = options?.mintCatalog ?? MINTS;
  const Wrapper = createWrapper(initialMints);
  const { mintCatalog, ...rest } = options ?? {};
  return render(ui, { wrapper: Wrapper, ...rest });
}
