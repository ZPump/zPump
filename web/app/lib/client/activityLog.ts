export type WalletActivityType = 'wrap' | 'unwrap';

export interface WalletActivityEntry {
  id: string;
  type: WalletActivityType;
  signature: string;
  symbol: string;
  amount: string;
  timestamp: number;
}

const STORAGE_KEY = 'zpump:wallet-activity';
const MAX_ENTRIES = 50;
const EVENT_NAME = 'zpump:activity';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readRawEntries(): WalletActivityEntry[] {
  if (!isBrowser()) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as WalletActivityEntry[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function writeEntries(entries: WalletActivityEntry[]) {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore write failures
  }
}

export function getWalletActivity(limit = MAX_ENTRIES): WalletActivityEntry[] {
  const entries = readRawEntries();
  return entries.slice(0, limit);
}

export function recordWalletActivity(entry: WalletActivityEntry) {
  if (!isBrowser()) {
    return;
  }
  const existing = readRawEntries().filter((item) => item.id !== entry.id);
  existing.unshift(entry);
  const trimmed = existing.slice(0, MAX_ENTRIES);
  writeEntries(trimmed);
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  } catch {
    // ignore dispatch errors
  }
}

export function subscribeToWalletActivity(callback: () => void): () => void {
  if (!isBrowser()) {
    return () => {};
  }
  const handler = () => {
    callback();
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}


