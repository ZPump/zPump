import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { getSimulationTokens, getStateVersion, SOL_TOKEN_ID } from './constants';
import { SimAccount, SimulationState, SimTransaction } from './types';

const STORAGE_KEY = 'zpump-simulation-state';

const ZERO = '0';

function normalizeBalances(balances: Record<string, string> | undefined): Record<string, string> {
  const tokens = getSimulationTokens();
  const next: Record<string, string> = {};
  tokens.forEach((token) => {
    const existing = balances?.[token.id];
    next[token.id] = typeof existing === 'string' ? existing : ZERO;
  });
  return next;
}

export function createSimulationAccount(label: string, seedSol = false): SimAccount {
  const keypair = Keypair.generate();
  const account: SimAccount = {
    id: crypto.randomUUID(),
    label,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(Array.from(keypair.secretKey)),
    createdAt: Date.now(),
    balances: normalizeBalances({})
  };
  if (seedSol) {
    account.balances = {
      ...account.balances,
      [SOL_TOKEN_ID]: '10'
    };
  }
  return account;
}

export function createInitialState(): SimulationState {
  const primary = createSimulationAccount('Primary', true);

  return {
    accounts: [primary],
    activeAccountId: primary.id,
    transactions: [],
    version: getStateVersion()
  };
}

export function readState(): SimulationState | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as SimulationState;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (parsed.version !== getStateVersion()) {
      return null;
    }
    const updatedAccounts = parsed.accounts.map((account) => ({
      ...account,
      balances: normalizeBalances(account.balances)
    }));
    return {
      ...parsed,
      accounts: updatedAccounts
    };
  } catch (error) {
    console.warn('[simulation] failed to read state', error);
    return null;
  }
}

export function writeState(state: SimulationState) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function addTransaction(existing: SimTransaction[], transaction: SimTransaction): SimTransaction[] {
  const next = [transaction, ...existing].slice(0, 50);
  return next;
}

export function prepareAccountForExport(account: SimAccount) {
  return {
    label: account.label,
    publicKey: account.publicKey,
    secretKey: account.secretKey
  };
}

export function restoreAccountFromSecret(secretKey: string, label?: string): SimAccount {
  const secretBytes = bs58.decode(secretKey);
  const keypair = Keypair.fromSecretKey(secretBytes);
  return {
    id: crypto.randomUUID(),
    label: label ?? `Imported ${keypair.publicKey.toBase58().slice(0, 4)}`,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(Array.from(keypair.secretKey)),
    createdAt: Date.now(),
    balances: normalizeBalances({})
  };
}

