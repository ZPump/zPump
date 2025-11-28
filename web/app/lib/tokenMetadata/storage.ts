/**
 * Token metadata storage utilities
 * Stores token metadata in localStorage for fast access across components
 */

export interface TokenMetadata {
  name: string;
  symbol: string;
  image?: string;
}

const STORAGE_KEY = 'zPump_tokenMetadata';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface StoredMetadata {
  metadata: TokenMetadata;
  timestamp: number;
}

interface MetadataCache {
  [mintAddress: string]: StoredMetadata;
}

/**
 * Load all cached token metadata from localStorage
 */
export function loadCachedMetadata(): Record<string, TokenMetadata> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return {};
    }

    const cache: MetadataCache = JSON.parse(stored);
    const now = Date.now();
    const result: Record<string, TokenMetadata> = {};

    // Filter out expired entries
    Object.entries(cache).forEach(([mint, entry]) => {
      if (now - entry.timestamp < CACHE_TTL_MS) {
        result[mint] = entry.metadata;
      }
    });

    // If we filtered out expired entries, save the cleaned cache
    if (Object.keys(result).length !== Object.keys(cache).length) {
      const cleanedCache: MetadataCache = {};
      Object.entries(result).forEach(([mint, metadata]) => {
        cleanedCache[mint] = {
          metadata,
          timestamp: cache[mint]?.timestamp || now
        };
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanedCache));
    }

    return result;
  } catch (error) {
    console.warn('[tokenMetadata/storage] Failed to load cached metadata:', error);
    return {};
  }
}

/**
 * Save token metadata to localStorage cache
 */
export function saveCachedMetadata(mintAddress: string, metadata: TokenMetadata): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const cache: MetadataCache = stored ? JSON.parse(stored) : {};
    cache[mintAddress] = {
      metadata,
      timestamp: Date.now()
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.warn('[tokenMetadata/storage] Failed to save cached metadata:', error);
  }
}

/**
 * Save multiple token metadata entries at once
 */
export function saveCachedMetadataBatch(metadataMap: Record<string, TokenMetadata>): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const cache: MetadataCache = stored ? JSON.parse(stored) : {};
    const now = Date.now();

    Object.entries(metadataMap).forEach(([mint, metadata]) => {
      cache[mint] = {
        metadata,
        timestamp: now
      };
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.warn('[tokenMetadata/storage] Failed to save cached metadata batch:', error);
  }
}

/**
 * Get cached metadata for a specific mint
 */
export function getCachedMetadata(mintAddress: string): TokenMetadata | undefined {
  const cache = loadCachedMetadata();
  return cache[mintAddress];
}

/**
 * Clear all cached metadata
 */
export function clearCachedMetadata(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('[tokenMetadata/storage] Failed to clear cached metadata:', error);
  }
}

