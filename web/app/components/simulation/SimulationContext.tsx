'use client';

import { createContext, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { SimAccount, SimulationState, SimTokenDefinition, SimTransaction } from '../../lib/simulation/types';
import {
  addTransaction,
  createInitialState,
  createSimulationAccount,
  prepareAccountForExport,
  readState,
  restoreAccountFromSecret,
  writeState
} from '../../lib/simulation/storage';
import { getSimulationTokens } from '../../lib/simulation/constants';

type TransferDirection = 'outgoing' | 'incoming';

export interface SimulationTransferResult {
  from?: SimAccount;
  to: SimAccount;
  transaction: SimTransaction;
}

export interface SimulationContextValue {
  ready: boolean;
  state: SimulationState;
  tokens: SimTokenDefinition[];
  activeAccount: SimAccount | null;
  setActiveAccount: (accountId: string) => void;
  createAccount: (label?: string) => SimAccount;
  renameAccount: (accountId: string, label: string) => void;
  exportAccount: (accountId: string) => { label: string; publicKey: string; secretKey: string } | null;
  deleteAccount: (accountId: string) => void;
  importAccount: (secretKey: string, label?: string) => SimAccount;
  updateBalance: (accountId: string, tokenId: string, amount: string) => void;
  incrementBalance: (accountId: string, tokenId: string, delta: string, direction?: TransferDirection) => void;
  recordTransaction: (transaction: SimTransaction) => void;
}

export const SimulationContext = createContext<SimulationContextValue | null>(null);

function ensurePositiveString(value: string): string {
  const amount = Number.parseFloat(value);
  if (Number.isFinite(amount) && amount >= 0) {
    return amount.toString();
  }
  return '0';
}

export function SimulationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SimulationState>(() => createInitialState());
  const [ready, setReady] = useState(false);
  const tokens = useMemo(() => getSimulationTokens(), []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const stored = readState();
    if (stored) {
      setState(stored);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    writeState(state);
  }, [state, ready]);

  const activeAccount = useMemo(() => {
    if (!state.activeAccountId) {
      return null;
    }
    return state.accounts.find((account) => account.id === state.activeAccountId) ?? null;
  }, [state.accounts, state.activeAccountId]);

  const setActiveAccount = useCallback((accountId: string) => {
    setState((prev) => ({
      ...prev,
      activeAccountId: accountId
    }));
  }, []);

  const createAccount = useCallback((label?: string): SimAccount => {
    const account = createSimulationAccount(label?.trim() || 'Simulation wallet');
    setState((prev) => ({
      ...prev,
      accounts: [...prev.accounts, account],
      activeAccountId: account.id
    }));
    return account;
  }, []);

  const renameAccount = useCallback((accountId: string, label: string) => {
    setState((prev) => ({
      ...prev,
      accounts: prev.accounts.map((account) => (account.id === accountId ? { ...account, label } : account))
    }));
  }, []);

  const exportAccount = useCallback((accountId: string) => {
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) {
      return null;
    }
    return prepareAccountForExport(account);
  }, [state.accounts]);

  const deleteAccount = useCallback((accountId: string) => {
    setState((prev) => {
      if (prev.accounts.length <= 1) {
        return prev;
      }
      const accounts = prev.accounts.filter((account) => account.id !== accountId);
      const nextActive =
        prev.activeAccountId === accountId ? accounts[0]?.id ?? null : prev.activeAccountId;
      return {
        ...prev,
        accounts,
        activeAccountId: nextActive
      };
    });
  }, []);

  const importAccount = useCallback((secretKey: string, label?: string) => {
    const account = restoreAccountFromSecret(secretKey, label);
    setState((prev) => ({
      ...prev,
      accounts: [...prev.accounts, account],
      activeAccountId: account.id
    }));
    return account;
  }, []);

  const updateBalance = useCallback((accountId: string, tokenId: string, amount: string) => {
    setState((prev) => ({
      ...prev,
      accounts: prev.accounts.map((account) =>
        account.id === accountId ? { ...account, balances: { ...account.balances, [tokenId]: ensurePositiveString(amount) } } : account
      )
    }));
  }, []);

  const incrementBalance = useCallback(
    (accountId: string, tokenId: string, delta: string) => {
      const numericDelta = Number.parseFloat(delta);
      if (!Number.isFinite(numericDelta)) {
        return;
      }
      setState((prev) => ({
        ...prev,
        accounts: prev.accounts.map((account) => {
          if (account.id !== accountId) {
            return account;
          }
          const current = Number.parseFloat(account.balances[tokenId] ?? '0');
          const nextAmount = Math.max(0, current + numericDelta);
          return {
            ...account,
            balances: {
              ...account.balances,
              [tokenId]: nextAmount.toString()
            }
          };
        })
      }));
    },
    []
  );

  const recordTransaction = useCallback((transaction: SimTransaction) => {
    setState((prev) => ({
      ...prev,
      transactions: addTransaction(prev.transactions, transaction)
    }));
  }, []);

  const value: SimulationContextValue = useMemo(
    () => ({
      ready,
      state,
      tokens,
      activeAccount,
      setActiveAccount,
      createAccount,
      renameAccount,
      exportAccount,
      deleteAccount,
      importAccount,
      updateBalance,
      incrementBalance,
      recordTransaction
    }),
    [
      ready,
      state,
      tokens,
      activeAccount,
      setActiveAccount,
      createAccount,
      renameAccount,
      exportAccount,
      deleteAccount,
      importAccount,
      updateBalance,
      incrementBalance,
      recordTransaction
    ]
  );

  return <SimulationContext.Provider value={value}>{children}</SimulationContext.Provider>;
}

