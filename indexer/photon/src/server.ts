import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const API_KEY_HEADER = 'x-ptf-api-key';

function canonicalizeHex(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `0x${'0'.repeat(64)}`;
  }
  let body: string;
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    body = trimmed.slice(2);
  } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    body = trimmed;
  } else if (/^\d+$/.test(trimmed)) {
    body = BigInt(trimmed).toString(16);
  } else {
    throw new Error(`invalid_hex:${value}`);
  }
  const normalised = body.replace(/^0+/, '') || '0';
  return `0x${normalised.padStart(64, '0').toLowerCase()}`;
}

function normalizeMintKey(mint: string): string {
  return mint.trim();
}

function normalizeViewId(value: string): string {
  return value.trim().toLowerCase();
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function canonicalizeNote(note: Note): Note {
  return {
    ...note,
    commitment: canonicalizeHex(note.commitment),
    mint: normalizeMintKey(note.mint),
    slot: Number(note.slot),
    viewTag: note.viewTag ? note.viewTag.toLowerCase() : undefined,
    leafIndex: typeof note.leafIndex === 'number' ? note.leafIndex : undefined
  };
}

function canonicalizeRootPayload(payload: RootResponse): RootResponse {
  return {
    current: canonicalizeHex(payload.current),
    recent: payload.recent.map((entry) => canonicalizeHex(entry))
  };
}

const RootResponseSchema = z.object({
  current: z.string(),
  recent: z.array(z.string())
});

const NoteSchema = z.object({
  commitment: z.string(),
  ciphertext: z.string(),
  mint: z.string(),
  slot: z.number(),
  viewTag: z.string().optional(),
  leafIndex: z.number().optional()
});

const NullifierResponseSchema = z.object({
  mint: z.string().optional(),
  nullifiers: z.array(z.string())
});

const NullifierWriteSchema = z.object({
  nullifiers: z.array(z.string()).min(1)
});

const NotesResponseSchema = z.object({
  viewKey: z.string().optional(),
  notes: z.array(NoteSchema)
});

const RootWriteSchema = z.object({
  current: z.string(),
  recent: z.array(z.string()).optional()
});

const BalanceDeltaSchema = z.object({
  mint: z.string(),
  delta: z.string()
});

const ActivityEntrySchema = z.object({
  id: z.string(),
  type: z.enum(['wrap', 'unwrap', 'transfer', 'transfer_from']),
  signature: z.string(),
  symbol: z.string(),
  amount: z.string(),
  timestamp: z.number()
});

const AllowanceEntrySchema = z.object({
  owner: z.string(),
  spender: z.string(),
  mint: z.string(),
  amount: z.string(),
  timestamp: z.number()
});

const SnapshotSchema = z.object({
  roots: z.record(RootResponseSchema).default({}),
  nullifiers: z.record(z.array(z.string())).default({}),
  notes: z.record(z.array(NoteSchema)).default({}),
  balances: z.record(z.record(z.string())).default({}),
  activity: z.record(z.array(ActivityEntrySchema)).default({}),
  allowances: z
    .record(
      z.record(
        z.record(
          z.object({
            amount: z.string(),
            updated: z.number()
          })
        )
      )
    )
    .default({})
});

const TransferValidationSchema = z.object({
  mint: z.string(),
  poolId: z.string().optional(),
  oldRoot: z.string(),
  nullifiers: z.array(z.string()).default([]),
  outputCommitments: z.array(z.string()).default([]),
  outputAmountCommitments: z.array(z.string()).default([])
});

type RootResponse = z.infer<typeof RootResponseSchema>;
type Note = z.infer<typeof NoteSchema>;
type SnapshotShape = z.infer<typeof SnapshotSchema>;
type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
type AllowanceEntry = z.infer<typeof AllowanceEntrySchema>;

const MAX_ACTIVITY_ENTRIES = 50;

class StateStore {
  private snapshotPath: string;
  private fixturePath: string;
  private state: SnapshotShape | null = null;

  constructor(options?: { snapshotPath?: string; fixturePath?: string }) {
    this.snapshotPath =
      options?.snapshotPath ?? path.join(__dirname, '..', 'data', 'state.json');
    this.fixturePath =
      options?.fixturePath ?? path.join(__dirname, '..', 'data', 'fixture-state.json');
  }

  async load(): Promise<void> {
    const snapshot = await this.tryRead(this.snapshotPath);
    if (snapshot) {
      this.state = this.canonicalizeState(snapshot);
      return;
    }
    const fixture = await this.tryRead(this.fixturePath);
    if (fixture) {
      this.state = this.canonicalizeState(fixture);
      return;
    }
    this.state = this.canonicalizeState(SnapshotSchema.parse({}));
  }

  private async tryRead(target: string): Promise<SnapshotShape | null> {
    try {
      const contents = await fs.readFile(target, 'utf8');
      return SnapshotSchema.parse(JSON.parse(contents));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.warn({ err: error }, `Failed to read ${target}`);
      return null;
    }
  }

  private ensureState(): SnapshotShape {
    if (!this.state) {
      this.state = SnapshotSchema.parse({});
    }
    return this.state;
  }

  async persist(): Promise<void> {
    const state = this.ensureState();
    await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.writeFile(this.snapshotPath, JSON.stringify(state, null, 2));
  }

  getRoots(mint: string): RootResponse | null {
    const key = normalizeMintKey(mint);
    return this.state?.roots[key] ?? null;
  }

  getNullifiers(mint: string): string[] {
    const key = normalizeMintKey(mint);
    return this.state?.nullifiers[key] ?? [];
  }

  getNotes(viewKey: string): Note[] {
    return this.state?.notes[viewKey] ?? [];
  }

  getBalances(wallet: string): Record<string, string> {
    return { ...(this.state?.balances[wallet] ?? {}) };
  }

  getActivity(viewId: string): ActivityEntry[] {
    const key = normalizeViewId(viewId);
    const entries = this.state?.activity?.[key] ?? [];
    return [...entries];
  }

  appendActivity(viewId: string, entry: ActivityEntry): ActivityEntry[] {
    const state = this.ensureState();
    const key = normalizeViewId(viewId);
    const existing = state.activity[key] ?? [];
    const deduped = existing.filter((item) => item.id !== entry.id);
    const next = [entry, ...deduped];
    if (next.length > MAX_ACTIVITY_ENTRIES) {
      next.length = MAX_ACTIVITY_ENTRIES;
    }
    state.activity[key] = next;
    return next;
  }

  getAllowance(owner: string, spender: string, mint: string): AllowanceEntry | null {
    const allowances = this.state?.allowances ?? {};
    const ownerEntry = allowances[owner];
    const spenderEntry = ownerEntry?.[spender];
    const mintEntry = spenderEntry?.[normalizeMintKey(mint)];
    if (!mintEntry) {
      return null;
    }
    return {
      owner,
      spender,
      mint: normalizeMintKey(mint),
      amount: mintEntry.amount,
      timestamp: mintEntry.updated
    };
  }

  setAllowance(owner: string, spender: string, mint: string, amount: string): AllowanceEntry {
    const state = this.ensureState();
    const normalizedOwner = owner;
    const normalizedSpender = spender;
    const normalizedMint = normalizeMintKey(mint);
    const allowOwner = (state.allowances[normalizedOwner] =
      state.allowances[normalizedOwner] ?? {});
    const allowSpender = (allowOwner[normalizedSpender] = allowOwner[normalizedSpender] ?? {});
    const entry = {
      amount,
      updated: Date.now()
    };
    allowSpender[normalizedMint] = entry;
    return {
      owner: normalizedOwner,
      spender: normalizedSpender,
      mint: normalizedMint,
      amount: entry.amount,
      timestamp: entry.updated
    };
  }

  upsertRoots(mint: string, payload: RootResponse): void {
    const state = this.ensureState();
    const key = normalizeMintKey(mint);
    state.roots[key] = canonicalizeRootPayload(payload);
  }

  upsertNotes(viewKey: string, notes: Note[]): void {
    const state = this.ensureState();
    state.notes[viewKey] = notes.map((note) => canonicalizeNote(note));
  }

  replaceNullifiers(mint: string, values: string[]): void {
    const state = this.ensureState();
    const key = normalizeMintKey(mint);
    state.nullifiers[key] = Array.from(
      new Set(values.map((value) => canonicalizeHex(value)))
    );
  }

  addNullifiers(mint: string, nullifiers: string[]): void {
    const state = this.ensureState();
    const key = normalizeMintKey(mint);
    const existing = new Set(state.nullifiers[key] ?? []);
    nullifiers.forEach((value) => existing.add(canonicalizeHex(value)));
    state.nullifiers[key] = Array.from(existing);
  }

  applyBalanceDelta(wallet: string, mint: string, delta: string): Record<string, string> {
    const state = this.ensureState();
    const mintKey = normalizeMintKey(mint);
    const balances = { ...(state.balances[wallet] ?? {}) };
    let current = 0n;
    if (balances[mintKey]) {
      try {
        current = BigInt(balances[mintKey]!);
      } catch {
        current = 0n;
      }
    }
    let next = current;
    try {
      next = current + BigInt(delta);
    } catch {
      throw new Error('invalid_delta');
    }
    if (next < 0n) {
      next = 0n;
    }
    if (next === 0n) {
      delete balances[mintKey];
    } else {
      balances[mintKey] = next.toString();
    }
    if (Object.keys(balances).length === 0) {
      delete state.balances[wallet];
    } else {
      state.balances[wallet] = balances;
    }
    return balances;
  }

  getNotesByMint(
    mint: string,
    options: { afterSlot?: number; viewTag?: string; limit?: number } = {}
  ): Note[] {
    const target = normalizeMintKey(mint);
    const { afterSlot, viewTag, limit } = options;
    const tag = viewTag ? viewTag.toLowerCase() : undefined;
    const state = this.ensureState();
    const result: Note[] = [];
    for (const noteList of Object.values(state.notes ?? {})) {
      for (const note of noteList) {
        if (normalizeMintKey(note.mint) !== target) {
          continue;
        }
        if (typeof afterSlot === 'number' && note.slot <= afterSlot) {
          continue;
        }
        if (tag && note.viewTag !== tag) {
          continue;
        }
        result.push(note);
      }
    }
    result.sort(compareNotes);
    if (typeof limit === 'number' && limit > 0 && result.length > limit) {
      return result.slice(0, limit);
    }
    return result;
  }

  private canonicalizeState(state: SnapshotShape): SnapshotShape {
    const canonicalRoots: Record<string, RootResponse> = {};
    for (const [mint, payload] of Object.entries(state.roots ?? {})) {
      const key = normalizeMintKey(mint);
      canonicalRoots[key] = canonicalizeRootPayload(payload);
    }
    const canonicalNotes: Record<string, Note[]> = {};
    for (const [viewKey, notes] of Object.entries(state.notes ?? {})) {
      canonicalNotes[viewKey] = notes.map((note) => canonicalizeNote(note));
    }
    const canonicalActivity: Record<string, ActivityEntry[]> = {};
    for (const [viewId, entries] of Object.entries(state.activity ?? {})) {
      const key = normalizeViewId(viewId);
      canonicalActivity[key] = entries.map((entry) => ActivityEntrySchema.parse(entry));
    }
    return {
      ...state,
      roots: canonicalRoots,
      notes: canonicalNotes,
      activity: canonicalActivity
    };
  }
}

function compareNotes(a: Note, b: Note): number {
  if (a.slot !== b.slot) {
    return a.slot - b.slot;
  }
  const indexA = typeof a.leafIndex === 'number' ? a.leafIndex : 0;
  const indexB = typeof b.leafIndex === 'number' ? b.leafIndex : 0;
  return indexA - indexB;
}

class PhotonClient {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(path: string): Promise<T | null> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url, { headers: this.headers() });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`upstream status ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async getRoots(mint: string): Promise<RootResponse | null> {
    const payload = await this.request<unknown>(`/roots/${mint}`);
    if (!payload) {
      return null;
    }
    const parsed = RootResponseSchema.safeParse(payload);
    if (parsed.success) {
      return canonicalizeRootPayload(parsed.data);
    }
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'result' in payload &&
      typeof (payload as { result?: unknown }).result === 'object'
    ) {
      const nested = RootResponseSchema.safeParse((payload as { result: unknown }).result);
      if (nested.success) {
        return canonicalizeRootPayload(nested.data);
      }
    }
    throw new Error('unexpected upstream roots payload');
  }

  async getNullifiers(mint: string): Promise<string[] | null> {
    const payload = await this.request<unknown>(`/nullifiers/${mint}`);
    if (!payload) {
      return null;
    }
    const parsed = NullifierResponseSchema.safeParse(payload);
    if (parsed.success) {
      return parsed.data.nullifiers;
    }
    if (Array.isArray(payload) && payload.every((value) => typeof value === 'string')) {
      return payload as string[];
    }
    throw new Error('unexpected upstream nullifier payload');
  }

  async getNotes(viewKey: string): Promise<Note[] | null> {
    const payload = await this.request<unknown>(`/notes/${viewKey}`);
    if (!payload) {
      return null;
    }
    const parsed = NotesResponseSchema.safeParse(payload);
    if (parsed.success) {
      return parsed.data.notes;
    }
    if (Array.isArray(payload)) {
      return payload.map((entry) => NoteSchema.parse(entry));
    }
    throw new Error('unexpected upstream notes payload');
  }
}

type FetchSource = 'snapshot' | 'cache' | 'upstream';

async function fetchRootsForMint(
  store: StateStore,
  upstream: PhotonClient | null,
  mint: string
): Promise<{ payload: RootResponse; source: FetchSource }> {
  const canonicalMint = normalizeMintKey(mint);
  if (upstream) {
    try {
      const remote = await upstream.getRoots(canonicalMint);
      if (remote) {
        const canonical = canonicalizeRootPayload(remote);
        store.upsertRoots(canonicalMint, canonical);
        return { payload: canonical, source: 'upstream' };
      }
    } catch (error) {
      logger.warn({ err: error, mint: canonicalMint }, 'failed to fetch roots from upstream');
    }
  }
  const local = store.getRoots(canonicalMint);
  if (!local) {
    throw new Error('mint_not_found');
  }
  return {
    payload: canonicalizeRootPayload(local),
    source: upstream ? 'cache' : 'snapshot'
  };
}

async function fetchNullifiersForMint(
  store: StateStore,
  upstream: PhotonClient | null,
  mint: string
): Promise<{ payload: string[]; source: FetchSource }> {
  const canonicalMint = normalizeMintKey(mint);
  if (upstream) {
    try {
      const remote = await upstream.getNullifiers(canonicalMint);
      if (remote) {
        store.replaceNullifiers(canonicalMint, remote);
        return { payload: remote, source: 'upstream' };
      }
    } catch (error) {
      logger.warn({ err: error, mint: canonicalMint }, 'failed to fetch nullifiers from upstream');
    }
  }
  const local = store.getNullifiers(canonicalMint);
  return {
    payload: local,
    source: upstream ? 'cache' : 'snapshot'
  };
}

function extractApiKey(req: express.Request): string | null {
  const header = req.header(API_KEY_HEADER);
  if (header) {
    return header.trim();
  }
  const authorization = req.header('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return null;
}

async function bootstrap() {
  const app = express();
  const port = Number(process.env.PORT ?? 8787);
  const enableBalanceApi =
    (process.env.ENABLE_BALANCE_API ?? 'true').toLowerCase() !== 'false';
  const store = new StateStore();
  await store.load();

  const upstreamUrl = process.env.PHOTON_URL;
  const upstreamClient = upstreamUrl
    ? new PhotonClient(upstreamUrl, process.env.PHOTON_API_KEY)
    : null;
  const apiKey = process.env.INDEXER_API_KEY ?? process.env.API_KEY;

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(
    morgan('dev', {
      stream: {
        write: (message) => logger.info(message.trim())
      }
    })
  );

  if (apiKey) {
    app.use((req, res, next) => {
      const provided = extractApiKey(req);
      if (!provided || provided !== apiKey) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, upstream: Boolean(upstreamClient) });
  });

  app.get('/roots/:mint', async (req, res) => {
    const mint = req.params.mint;
    try {
      if (upstreamClient) {
        const remote = await upstreamClient.getRoots(mint);
        if (remote) {
          const canonical = canonicalizeRootPayload(remote);
          store.upsertRoots(mint, canonical);
          res.json({ mint, ...canonical, source: 'upstream' });
          return;
        }
      }
      const local = store.getRoots(mint);
      if (!local) {
        res.status(404).json({ error: 'mint_not_found' });
        return;
      }
      const canonical = canonicalizeRootPayload(local);
      res.json({ mint, ...canonical, source: upstreamClient ? 'cache' : 'snapshot' });
    } catch (error) {
      logger.error({ err: error, mint }, 'failed to resolve roots');
      res.status(502).json({ error: 'upstream_failed' });
    }
  });

  app.post('/roots/:mint', (req, res) => {
    const mint = req.params.mint;
    const parsed = RootWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const payload: RootResponse = {
      current: canonicalizeHex(parsed.data.current),
      recent: parsed.data.recent ? parsed.data.recent.map((entry) => canonicalizeHex(entry)) : []
    };
    store.upsertRoots(mint, payload);
    res.json({ mint, ...payload, source: 'local' });
  });

  app.get('/nullifiers/:mint', async (req, res) => {
    const mint = req.params.mint;
    try {
      if (upstreamClient) {
        const remote = await upstreamClient.getNullifiers(mint);
        if (remote) {
          store.replaceNullifiers(mint, remote);
          res.json({ mint, nullifiers: remote, source: 'upstream' });
          return;
        }
      }
      const local = store.getNullifiers(mint);
      res.json({ mint, nullifiers: local, source: upstreamClient ? 'cache' : 'snapshot' });
    } catch (error) {
      logger.error({ err: error, mint }, 'failed to resolve nullifiers');
      res.status(502).json({ error: 'upstream_failed' });
    }
  });

  app.post('/nullifiers/:mint', async (req, res) => {
    const mint = req.params.mint;
    const parsed = NullifierWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const normalised = parsed.data.nullifiers.map((value) =>
      value.startsWith('0x') ? value : `0x${value}`
    );
    try {
      store.addNullifiers(mint, normalised);
      const current = store.getNullifiers(mint);
      res.json({ mint, nullifiers: current, source: 'local' });
    } catch (error) {
      logger.error({ err: error, mint }, 'failed to append nullifiers');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/notes/:viewKey', async (req, res) => {
    const viewKey = req.params.viewKey;
    try {
      if (upstreamClient) {
        const remote = await upstreamClient.getNotes(viewKey);
        if (remote) {
          store.upsertNotes(viewKey, remote);
          res.json({ viewKey, notes: remote, source: 'upstream' });
          return;
        }
      }
      const notes = store.getNotes(viewKey);
      res.json({ viewKey, notes, source: upstreamClient ? 'cache' : 'snapshot' });
    } catch (error) {
      logger.error({ err: error, viewKey }, 'failed to resolve notes');
      res.status(502).json({ error: 'upstream_failed' });
    }
  });

  app.get('/notes/mint/:mint', (req, res) => {
    const mint = req.params.mint;
    const normalizedMint = normalizeMintKey(mint);
    const afterSlot = parseOptionalNumber(req.query.afterSlot);
    const limit = parseOptionalNumber(req.query.limit);
    const viewTag =
      typeof req.query.viewTag === 'string' && req.query.viewTag.trim().length > 0
        ? req.query.viewTag
        : undefined;
    const notes = store.getNotesByMint(normalizedMint, { afterSlot, viewTag, limit });
    const cursor = notes.length > 0 ? notes[notes.length - 1].slot : afterSlot ?? null;
    const hasMore = typeof limit === 'number' && limit > 0 ? notes.length === limit : false;
    res.json({ mint: normalizedMint, notes, cursor, hasMore });
  });

  app.get('/sync/:mint', async (req, res) => {
    const mint = req.params.mint;
    try {
      const rootsResult = await fetchRootsForMint(store, upstreamClient, mint);
      const nullifiersResult = await fetchNullifiersForMint(store, upstreamClient, mint);
      const canonicalMint = normalizeMintKey(mint);
      const afterSlot = parseOptionalNumber(req.query.afterSlot);
      const limit = parseOptionalNumber(req.query.limit);
      const viewTag =
        typeof req.query.viewTag === 'string' && req.query.viewTag.trim().length > 0
          ? req.query.viewTag
          : undefined;
      const notes = store.getNotesByMint(canonicalMint, { afterSlot, viewTag, limit });
      const cursor = notes.length > 0 ? notes[notes.length - 1].slot : afterSlot ?? null;
      const hasMore = typeof limit === 'number' && limit > 0 ? notes.length === limit : false;
      res.json({
        mint: canonicalMint,
        roots: rootsResult.payload,
        nullifiers: nullifiersResult.payload,
        notes,
        cursor,
        hasMore,
        sources: {
          roots: rootsResult.source,
          nullifiers: nullifiersResult.source,
          notes: 'snapshot'
        }
      });
    } catch (error) {
      if ((error as Error).message === 'mint_not_found') {
        res.status(404).json({ error: 'mint_not_found' });
        return;
      }
      logger.error({ err: error, mint }, 'failed to assemble sync payload');
      res.status(502).json({ error: 'upstream_failed' });
    }
  });

  app.get('/activity/:viewId', (req, res) => {
    const viewId = req.params.viewId;
    if (!viewId) {
      res.status(400).json({ error: 'view_id_required' });
      return;
    }
    try {
      const entries = store.getActivity(viewId);
      res.json({ viewId: normalizeViewId(viewId), entries, source: 'local' });
    } catch (error) {
      logger.error({ err: error, viewId }, 'failed to read activity log');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/activity/:viewId', (req, res) => {
    const viewId = req.params.viewId;
    if (!viewId) {
      res.status(400).json({ error: 'view_id_required' });
      return;
    }
    const parsed = ActivityEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    try {
      const entries = store.appendActivity(viewId, parsed.data);
      res.json({ viewId: normalizeViewId(viewId), entries, source: 'local' });
    } catch (error) {
      logger.error({ err: error, viewId }, 'failed to append activity entry');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/transfers/validate', (req, res) => {
    const parsed = TransferValidationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
      return;
    }
    const { mint, poolId, oldRoot, nullifiers, outputCommitments, outputAmountCommitments } =
      parsed.data;

    if (outputCommitments.length !== outputAmountCommitments.length) {
      res.status(400).json({ error: 'output_set_mismatch' });
      return;
    }

    try {
      const canonicalMint = normalizeMintKey(mint);
      const canonicalOldRoot = canonicalizeHex(oldRoot);
      const roots = store.getRoots(canonicalMint);
      if (!roots) {
        res.status(404).json({ error: 'mint_not_found' });
        return;
      }
      const currentRoot = canonicalizeHex(roots.current);
      const recentRoots = (roots.recent ?? []).map((entry) => canonicalizeHex(entry));
      const rootMatched =
        canonicalOldRoot === currentRoot || recentRoots.includes(canonicalOldRoot);
      if (!rootMatched) {
        res.status(409).json({
          error: 'root_mismatch',
          provided: canonicalOldRoot,
          expected: currentRoot,
          recent: recentRoots
        });
        return;
      }

      const canonicalNullifiers = nullifiers.map((entry) => canonicalizeHex(entry));
      const knownNullifiers = new Set(
        store.getNullifiers(canonicalMint).map((entry) => canonicalizeHex(entry))
      );
      const duplicates = canonicalNullifiers.filter((entry) => knownNullifiers.has(entry));
      if (duplicates.length > 0) {
        res.status(409).json({ error: 'nullifier_conflict', duplicates });
        return;
      }

      const canonicalOutputs = outputCommitments.map((entry) => canonicalizeHex(entry));
      const canonicalAmountCommitments = outputAmountCommitments.map((entry) =>
        canonicalizeHex(entry)
      );

      res.json({
        mint: canonicalMint,
        poolId: poolId ?? null,
        oldRoot: canonicalOldRoot,
        currentRoot,
        nullifiers: canonicalNullifiers,
        outputCommitments: canonicalOutputs,
        outputAmountCommitments: canonicalAmountCommitments,
        source: 'local'
      });
    } catch (error) {
      logger.error({ err: error }, 'failed to validate transfer payload');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/allowances/:owner/:spender/:mint', (req, res) => {
    const { owner, spender, mint } = req.params;
    if (!owner || !spender || !mint) {
      res.status(400).json({ error: 'allowance_params_required' });
      return;
    }
    try {
      const entry = store.getAllowance(owner, spender, mint);
      if (!entry) {
        res.status(404).json({ error: 'allowance_not_found' });
        return;
      }
      res.json(entry);
    } catch (error) {
      logger.error({ err: error, owner, spender, mint }, 'failed to read allowance');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/allowances/:owner/:spender/:mint', (req, res) => {
    const { owner, spender, mint } = req.params;
    if (!owner || !spender || !mint) {
      res.status(400).json({ error: 'allowance_params_required' });
      return;
    }
    const parsed = AllowanceEntrySchema.safeParse({
      owner,
      spender,
      mint,
      amount: req.body?.amount ?? req.body?.value ?? req.body?.quantity ?? req.body?.allowance ?? '0',
      timestamp: Date.now()
    });
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
      return;
    }
    try {
      const next = store.setAllowance(owner, spender, mint, parsed.data.amount);
      res.json(next);
    } catch (error) {
      logger.error({ err: error, owner, spender, mint }, 'failed to persist allowance');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  if (enableBalanceApi) {
    app.get('/balances/:wallet', (req, res) => {
      const wallet = req.params.wallet;
      const balances = store.getBalances(wallet);
      res.json({ wallet, balances, source: 'local' });
    });

    app.post('/balances/:wallet', (req, res) => {
      const wallet = req.params.wallet;
      const parsed = BalanceDeltaSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      try {
        const balances = store.applyBalanceDelta(wallet, parsed.data.mint, parsed.data.delta);
        res.json({ wallet, balances, source: 'local' });
      } catch (error) {
        const message = (error as Error).message;
        if (message === 'invalid_delta') {
          res.status(400).json({ error: 'invalid_delta' });
          return;
        }
        logger.error({ err: error, wallet }, 'failed to adjust balances');
        res.status(500).json({ error: 'internal_error' });
      }
    });
  } else {
    app.get('/balances/:_wallet', (_req, res) => {
      res.status(404).json({ error: 'endpoint_disabled' });
    });
    app.post('/balances/:_wallet', (_req, res) => {
      res.status(404).json({ error: 'endpoint_disabled' });
    });
  }

  const server = app.listen(port, () => {
    logger.info({ port, upstream: Boolean(upstreamClient) }, 'Photon indexer listening');
  });

  const shutdown = async () => {
    logger.info('Shutting down indexer');
    server.close();
    await store.persist();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bootstrap().catch((error) => {
    logger.error(error, 'Failed to start Photon indexer');
    process.exit(1);
  });
}

export type { RootResponse, Note };
export { StateStore };
