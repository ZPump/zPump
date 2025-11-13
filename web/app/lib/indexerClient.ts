import { canonicalizeHex } from './onchain/utils';

interface IndexerClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface IndexerRootResult {
  mint: string;
  current: string;
  recent: string[];
  source?: string;
}

export interface IndexerNullifierResult {
  mint: string;
  nullifiers: string[];
  source?: string;
}

export interface IndexerNoteResult {
  viewKey: string;
  notes: IndexerNote[];
  source?: string;
}

export interface IndexerNote {
  commitment: string;
  ciphertext: string;
  mint: string;
  slot: number;
}

export interface IndexerBalanceResult {
  wallet: string;
  balances: Record<string, string>;
  source?: string;
}

export class IndexerClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: IndexerClientOptions) {
    const defaultBase =
      options?.baseUrl ??
      (typeof window !== 'undefined'
        ? '/api/indexer'
        : process.env.NEXT_PUBLIC_INDEXER_URL ??
          process.env.INDEXER_INTERNAL_URL ??
          'http://127.0.0.1:8787');

    this.baseUrl = defaultBase;
    this.apiKey = options?.apiKey ?? process.env.NEXT_PUBLIC_INDEXER_API_KEY;
    const fetchFn = options?.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!fetchFn) {
      throw new Error('Global fetch is not available. Provide a fetchImpl when constructing IndexerClient.');
    }
    this.fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchFn.call(globalThis, input, init)) as typeof fetch;
  }

  async getRoots(mint: string): Promise<IndexerRootResult | null> {
    const payload = await this.request(`/roots/${mint}`);
    if (!payload) {
      return null;
    }
    return this.parseRoots(payload, mint);
  }

  async getNullifiers(mint: string): Promise<IndexerNullifierResult | null> {
    const payload = await this.request(`/nullifiers/${mint}`);
    if (!payload) {
      return null;
    }
    return this.parseNullifiers(payload, mint);
  }

  async appendNullifiers(mint: string, nullifiers: string[]): Promise<void> {
    if (!nullifiers.length) {
      return;
    }
    const normalised = nullifiers
      .map((entry) => this.asCanonicalHex(entry) ?? entry)
      .filter((entry): entry is string => typeof entry === 'string');
    const url = this.buildUrl(`/nullifiers/${mint}`);
    const headers: HeadersInit = {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['x-ptf-api-key'] = this.apiKey;
    }
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nullifiers: normalised })
    });
    if (!response.ok) {
      throw new Error(`Indexer error: ${response.status} ${response.statusText}`);
    }
    await response.json().catch(() => null);
  }

  async getNotes(viewKey: string): Promise<IndexerNoteResult | null> {
    const payload = await this.request(`/notes/${viewKey}`);
    if (!payload) {
      return null;
    }
    return this.parseNotes(payload, viewKey);
  }

  async getBalances(wallet: string): Promise<IndexerBalanceResult | null> {
    const payload = await this.request(`/balances/${wallet}`);
    if (!payload) {
      return null;
    }
    if (payload && typeof payload === 'object') {
      const entry = payload as Record<string, unknown>;
      const balances = entry.balances;
      if (balances && typeof balances === 'object') {
        const result: IndexerBalanceResult = {
          wallet: typeof entry.wallet === 'string' ? entry.wallet : wallet,
          balances: this.normaliseBalanceMap(balances),
          source: typeof entry.source === 'string' ? entry.source : undefined
        };
        return result;
      }
    }
    throw new Error('Unexpected indexer balances payload');
  }

  async adjustBalance(wallet: string, mint: string, delta: bigint): Promise<Record<string, string>> {
    if (!wallet || !mint || delta === 0n) {
      return {};
    }
    const url = this.buildUrl(`/balances/${wallet}`);
    const headers: HeadersInit = {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['x-ptf-api-key'] = this.apiKey;
    }
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mint, delta: delta.toString() })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      let message = response.statusText;
      if (payload && typeof payload === 'object' && payload !== null) {
        message = (payload as { error?: string; message?: string }).error ?? message;
      }
      throw new Error(`Indexer error: ${response.status} ${message}`);
    }
    if (payload && typeof payload === 'object' && payload !== null && 'balances' in payload) {
      const entry = payload as { balances?: unknown };
      if (entry.balances && typeof entry.balances === 'object') {
        return this.normaliseBalanceMap(entry.balances);
      }
    }
    return {};
  }

  private async request(path: string): Promise<unknown | null> {
    const url = this.buildUrl(path);
    const headers: HeadersInit = {
      Accept: 'application/json'
    };
    if (this.apiKey) {
      headers['x-ptf-api-key'] = this.apiKey;
    }
    const response = await this.fetchImpl(url, { headers });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Indexer error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  private buildUrl(path: string): string {
    if (this.baseUrl.startsWith('http://') || this.baseUrl.startsWith('https://')) {
      return new URL(path, this.baseUrl).toString();
    }
    const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private parseRoots(payload: unknown, fallbackMint: string): IndexerRootResult {
    if (payload && typeof payload === 'object') {
      const entry = payload as Record<string, unknown>;
      const current = this.asCanonicalHex(entry.current);
      if (current) {
        return {
          mint: typeof entry.mint === 'string' ? entry.mint : fallbackMint,
          current,
            recent: this.asHexArray(entry.recent),
          source: typeof entry.source === 'string' ? entry.source : undefined
        };
      }
      if ('result' in entry && entry.result && typeof entry.result === 'object') {
        const inner = entry.result as Record<string, unknown>;
        const innerCurrent = this.asCanonicalHex(inner.current);
        if (innerCurrent) {
          return {
            mint: typeof inner.mint === 'string' ? inner.mint : fallbackMint,
            current: innerCurrent,
            recent: this.asHexArray(inner.recent),
            source: typeof inner.source === 'string' ? inner.source : undefined
          };
        }
      }
    }
    throw new Error('Unexpected indexer roots payload');
  }

  private parseNullifiers(payload: unknown, fallbackMint: string): IndexerNullifierResult {
    if (Array.isArray(payload) && payload.every((value) => typeof value === 'string')) {
        const canonical = payload
          .map((entry) => this.asCanonicalHex(entry) ?? entry)
          .filter((entry): entry is string => typeof entry === 'string');
        return {
          mint: fallbackMint,
          nullifiers: canonical,
          source: undefined
        };
    }
    if (payload && typeof payload === 'object') {
      const entry = payload as Record<string, unknown>;
      const nullifiers = entry.nullifiers;
      if (Array.isArray(nullifiers) && nullifiers.every((value) => typeof value === 'string')) {
        return {
          mint: typeof entry.mint === 'string' ? entry.mint : fallbackMint,
          nullifiers: nullifiers
            .map((value) => this.asCanonicalHex(value) ?? (value as string))
            .filter((value): value is string => typeof value === 'string'),
          source: typeof entry.source === 'string' ? entry.source : undefined
        };
      }
    }
    throw new Error('Unexpected indexer nullifiers payload');
  }

  private parseNotes(payload: unknown, fallbackViewKey: string): IndexerNoteResult {
    if (payload && typeof payload === 'object') {
      const entry = payload as Record<string, unknown>;
      const notes = this.normaliseNotes(entry.notes);
      if (notes) {
        return {
          viewKey: typeof entry.viewKey === 'string' ? entry.viewKey : fallbackViewKey,
          notes,
          source: typeof entry.source === 'string' ? entry.source : undefined
        };
      }
      const nested = entry.result;
      if (nested && typeof nested === 'object') {
        const nestedEntry = nested as Record<string, unknown>;
        const nestedNotes = this.normaliseNotes(nestedEntry.notes);
        if (nestedNotes) {
          return {
            viewKey: typeof nestedEntry.viewKey === 'string' ? nestedEntry.viewKey : fallbackViewKey,
            notes: nestedNotes,
            source: typeof nestedEntry.source === 'string' ? nestedEntry.source : undefined
          };
        }
      }
    }
    throw new Error('Unexpected indexer notes payload');
  }

  private normaliseNotes(value: unknown): IndexerNote[] | null {
    if (!Array.isArray(value)) {
      return null;
    }
    const notes: IndexerNote[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const note = entry as Record<string, unknown>;
      if (typeof note.commitment !== 'string' || typeof note.ciphertext !== 'string' || typeof note.mint !== 'string') {
        return null;
      }
      const commitment = this.asCanonicalHex(note.commitment);
      if (!commitment) {
        return null;
      }
      notes.push({
        commitment,
        ciphertext: note.ciphertext,
        mint: note.mint,
        slot: typeof note.slot === 'number' ? note.slot : Number(note.slot ?? 0)
      });
    }
    return notes;
  }

  private asHexArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => this.asCanonicalHex(entry))
      .filter((entry): entry is string => Boolean(entry));
  }

  private asCanonicalHex(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    try {
      return canonicalizeHex(value);
    } catch {
      return null;
    }
  }

  private normaliseBalanceMap(value: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (!value || typeof value !== 'object') {
      return result;
    }
    for (const [mint, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string') {
        result[mint] = raw;
      }
    }
    return result;
  }
}


