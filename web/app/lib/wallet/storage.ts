'use client';

import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

export interface StoredAccount {
  id: string;
  label: string;
  secretKey: string;
  publicKey: string;
  createdAt: number;
}

export interface WalletStorageState {
  accounts: StoredAccount[];
  activeId: string;
}

const STORAGE_KEY = 'zpump.localWallet.v1';

function createDefaultAccount(): StoredAccount {
  const keypair = Keypair.generate();
  return {
    id: crypto.randomUUID(),
    label: 'Account 1',
    secretKey: bs58.encode(keypair.secretKey),
    publicKey: keypair.publicKey.toBase58(),
    createdAt: Date.now()
  };
}

export function readWalletState(): WalletStorageState {
  if (typeof window === 'undefined') {
    const fallback = createDefaultAccount();
    return { accounts: [fallback], activeId: fallback.id };
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const fallback = createDefaultAccount();
    const state = { accounts: [fallback], activeId: fallback.id };
    writeWalletState(state);
    return state;
  }

  try {
    const parsed = JSON.parse(raw) as WalletStorageState;
    if (!parsed.accounts || parsed.accounts.length === 0 || !parsed.activeId) {
      throw new Error('invalid');
    }
    const normalizedAccounts = parsed.accounts.map((account) => {
      if (!account.publicKey) {
        try {
          const keypair = Keypair.fromSecretKey(bs58.decode(account.secretKey));
          return { ...account, publicKey: keypair.publicKey.toBase58() };
        } catch {
          return account;
        }
      }
      return account;
    });
    const normalized: WalletStorageState = {
      accounts: normalizedAccounts,
      activeId: normalizedAccounts.some((account) => account.id === parsed.activeId)
        ? parsed.activeId
        : normalizedAccounts[0].id
    };
    if (typeof window !== 'undefined') {
      writeWalletState(normalized);
    }
    return normalized;
  } catch {
    const fallback = createDefaultAccount();
    const state = { accounts: [fallback], activeId: fallback.id };
    writeWalletState(state);
    return state;
  }
}

export function writeWalletState(state: WalletStorageState) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function addAccount(state: WalletStorageState, label?: string): WalletStorageState {
  const keypair = Keypair.generate();
  const account: StoredAccount = {
    id: crypto.randomUUID(),
    label: label?.trim() || `Account ${state.accounts.length + 1}`,
    secretKey: bs58.encode(keypair.secretKey),
    publicKey: keypair.publicKey.toBase58(),
    createdAt: Date.now()
  };
  const next: WalletStorageState = {
    accounts: [...state.accounts, account],
    activeId: account.id
  };
  writeWalletState(next);
  return next;
}

export function importAccount(state: WalletStorageState, secretKey: string, label?: string): WalletStorageState {
  const decoded = bs58.decode(secretKey);
  if (decoded.length !== 64) {
    throw new Error('Secret key must be 64 bytes (base58 encoded)');
  }
  const keypair = Keypair.fromSecretKey(decoded);
  const exists = state.accounts.some((account) => account.publicKey === keypair.publicKey.toBase58());
  if (exists) {
    throw new Error('Account already imported');
  }

  const account: StoredAccount = {
    id: crypto.randomUUID(),
    label: label?.trim() || `Imported ${state.accounts.length + 1}`,
    secretKey,
    publicKey: keypair.publicKey.toBase58(),
    createdAt: Date.now()
  };
  const next: WalletStorageState = { accounts: [...state.accounts, account], activeId: account.id };
  writeWalletState(next);
  return next;
}

export function renameAccount(state: WalletStorageState, id: string, label: string): WalletStorageState {
  const next: WalletStorageState = {
    ...state,
    accounts: state.accounts.map((account) => (account.id === id ? { ...account, label } : account))
  };
  writeWalletState(next);
  return next;
}

export function deleteAccount(state: WalletStorageState, id: string): WalletStorageState {
  const remaining = state.accounts.filter((account) => account.id !== id);
  if (remaining.length === 0) {
    return state;
  }
  const nextActive = state.activeId === id ? remaining[0].id : state.activeId;
  const next: WalletStorageState = { accounts: remaining, activeId: nextActive };
  writeWalletState(next);
  return next;
}

export function setActiveAccount(state: WalletStorageState, id: string): WalletStorageState {
  const exists = state.accounts.some((account) => account.id === id);
  if (!exists) {
    return state;
  }
  const next: WalletStorageState = { ...state, activeId: id };
  writeWalletState(next);
  return next;
}

