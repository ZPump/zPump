'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { ManagedKeypairWalletAdapter, ManagedWalletName } from '../../lib/wallet/ManagedAdapter';
import {
  addAccount,
  deleteAccount as deleteAccountStorage,
  importAccount as importAccountStorage,
  readWalletState,
  renameAccount as renameAccountStorage,
  setActiveAccount,
  StoredAccount,
  WalletStorageState,
  writeWalletState
} from '../../lib/wallet/storage';

interface LocalWalletAccount extends StoredAccount {}

interface LocalWalletContextValue {
  ready: boolean;
  accounts: LocalWalletAccount[];
  activeAccount: LocalWalletAccount | null;
  selectAccount(id: string): void;
  createAccount(label?: string): void;
  importAccount(secretKey: string, label?: string): void;
  renameAccount(id: string, label: string): void;
  deleteAccount(id: string): void;
}

const LocalWalletContext = createContext<LocalWalletContextValue | null>(null);

interface LocalWalletProviderProps {
  adapter: ManagedKeypairWalletAdapter;
  children: ReactNode;
}

export function LocalWalletProvider({ adapter, children }: LocalWalletProviderProps) {
  const [state, setState] = useState<WalletStorageState>(() => readWalletState());
  const wallet = useWallet();

  const activeAccount = useMemo(
    () => state.accounts.find((account) => account.id === state.activeId) ?? null,
    [state]
  );

  useEffect(() => {
    writeWalletState(state);
  }, [state]);

  useEffect(() => {
    if (!activeAccount) {
      return;
    }
    const keypair = Keypair.fromSecretKey(bs58.decode(activeAccount.secretKey));
    const current = adapter.publicKey?.toBase58();
    if (current !== activeAccount.publicKey) {
      adapter.setKeypair(keypair);
    }

    if (wallet.wallet?.adapter !== adapter) {
      wallet.select(ManagedWalletName);
    }

    if (
      !wallet.connected ||
      !wallet.publicKey ||
      wallet.publicKey.toBase58() !== activeAccount.publicKey
    ) {
      if (!wallet.connecting) {
        wallet.connect().catch(() => {
          /* handled via toast in UI */
        });
      }
    }
  }, [activeAccount, adapter, wallet]);

  const value = useMemo<LocalWalletContextValue>(
    () => ({
      ready: Boolean(activeAccount),
      accounts: state.accounts,
      activeAccount,
      selectAccount: (id) => setState((prev) => setActiveAccount(prev, id)),
      createAccount: (label) => setState((prev) => addAccount(prev, label)),
      importAccount: (secretKey, label) =>
        setState((prev) => importAccountStorage(prev, secretKey, label)),
      renameAccount: (id, label) => setState((prev) => renameAccountStorage(prev, id, label)),
      deleteAccount: (id) => setState((prev) => deleteAccountStorage(prev, id))
    }),
    [activeAccount, state.accounts]
  );

  return <LocalWalletContext.Provider value={value}>{children}</LocalWalletContext.Provider>;
}

export function useLocalWallet(): LocalWalletContextValue {
  const context = useContext(LocalWalletContext);
  if (!context) {
    throw new Error('useLocalWallet must be used within LocalWalletProvider');
  }
  return context;
}

