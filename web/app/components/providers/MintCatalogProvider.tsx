'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { MintConfig } from '../../config/mints';

interface MintCatalogContextValue {
  mints: MintConfig[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const MintCatalogContext = createContext<MintCatalogContextValue | null>(null);

interface MintCatalogProviderProps {
  children: ReactNode;
  initialMints?: MintConfig[];
}

async function fetchMintCatalog(): Promise<MintConfig[]> {
  const response = await fetch('/api/mints', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('failed_to_fetch_mints');
  }
  const payload = (await response.json()) as { mints?: MintConfig[] };
  return payload.mints ?? [];
}

export function MintCatalogProvider({ children, initialMints }: MintCatalogProviderProps) {
  const [mints, setMints] = useState<MintConfig[]>(initialMints ?? []);
  const [loading, setLoading] = useState<boolean>(!initialMints);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const catalog = await fetchMintCatalog();
      setMints(catalog);
    } catch (caught) {
      setError((caught as Error).message ?? 'failed_to_fetch_mints');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialMints && initialMints.length > 0) {
      return;
    }
    void refresh();
  }, [initialMints, refresh]);

  const value = useMemo<MintCatalogContextValue>(
    () => ({
      mints,
      loading,
      error,
      refresh
    }),
    [mints, loading, error, refresh]
  );

  return <MintCatalogContext.Provider value={value}>{children}</MintCatalogContext.Provider>;
}

export function useMintCatalog() {
  const context = useContext(MintCatalogContext);
  if (!context) {
    throw new Error('useMintCatalog must be used within MintCatalogProvider');
  }
  return context;
}


