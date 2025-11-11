interface RootCacheEntry {
  mint: string;
  current: string;
  recent: string[];
  source?: string;
  updatedAt: number;
}

interface NullifierCacheEntry {
  mint: string;
  values: string[];
  source?: string;
  updatedAt: number;
}

const ROOT_CACHE_KEY = 'zpump-indexer-roots';
const NULLIFIER_CACHE_KEY = 'zpump-indexer-nullifiers';
const CACHE_TTL_MS = 60_000;

function readCache<T>(key: string): T | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`[indexerCache] failed to read ${key}`, error);
    return null;
  }
}

function writeCache<T>(key: string, value: T) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`[indexerCache] failed to persist ${key}`, error);
  }
}

export function getCachedRoots(mint: string): RootCacheEntry | null {
  const entries = readCache<RootCacheEntry[]>(ROOT_CACHE_KEY);
  if (!entries) {
    return null;
  }
  const entry = entries.find((candidate) => candidate.mint === mint);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    return null;
  }
  return entry;
}

export function setCachedRoots(entry: Omit<RootCacheEntry, 'updatedAt'>) {
  const existing = readCache<RootCacheEntry[]>(ROOT_CACHE_KEY) ?? [];
  const next = existing.filter((candidate) => candidate.mint !== entry.mint);
  next.push({ ...entry, updatedAt: Date.now() });
  writeCache(ROOT_CACHE_KEY, next);
}

export function getCachedNullifiers(mint: string): NullifierCacheEntry | null {
  const entries = readCache<NullifierCacheEntry[]>(NULLIFIER_CACHE_KEY);
  if (!entries) {
    return null;
  }
  const entry = entries.find((candidate) => candidate.mint === mint);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    return null;
  }
  return entry;
}

export function setCachedNullifiers(entry: Omit<NullifierCacheEntry, 'updatedAt'>) {
  const existing = readCache<NullifierCacheEntry[]>(NULLIFIER_CACHE_KEY) ?? [];
  const next = existing.filter((candidate) => candidate.mint !== entry.mint);
  next.push({ ...entry, updatedAt: Date.now() });
  writeCache(NULLIFIER_CACHE_KEY, next);
}


