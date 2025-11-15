import fs from 'fs/promises';
import path from 'path';
import { resolveRepoPath } from './paths';

export type WalletActivityType = 'wrap' | 'unwrap';

export interface WalletActivityEntry {
  id: string;
  type: WalletActivityType;
  signature: string;
  symbol: string;
  amount: string;
  timestamp: number;
}

export interface WalletActivityRecord extends WalletActivityEntry {
  wallet: string;
}

const ACTIVITY_PATH = resolveRepoPath('web', 'app', 'wallet-activity.json');
const MAX_ENTRIES_PER_WALLET = 100;

async function readCatalog(): Promise<Record<string, WalletActivityEntry[]>> {
  try {
    const raw = await fs.readFile(ACTIVITY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, WalletActivityEntry[]>;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      await writeCatalog({});
      return {};
    }
    throw error;
  }
}

async function writeCatalog(payload: Record<string, WalletActivityEntry[]>) {
  await fs.mkdir(path.dirname(ACTIVITY_PATH), { recursive: true });
  await fs.writeFile(ACTIVITY_PATH, JSON.stringify(payload, null, 2));
}

export async function getWalletActivityEntries(wallet: string): Promise<WalletActivityEntry[]> {
  if (!wallet) {
    return [];
  }
  const catalog = await readCatalog();
  return catalog[wallet] ?? [];
}

export async function appendWalletActivityEntry(entry: WalletActivityRecord): Promise<void> {
  const catalog = await readCatalog();
  const existing = catalog[entry.wallet] ?? [];
  const filtered = existing.filter((item) => item.id !== entry.id);
  filtered.unshift(entry);
  catalog[entry.wallet] = filtered.slice(0, MAX_ENTRIES_PER_WALLET);
  await writeCatalog(catalog);
}

export async function resetWalletActivityLog() {
  await writeCatalog({});
}

