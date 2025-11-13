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

const RootResponseSchema = z.object({
  current: z.string(),
  recent: z.array(z.string())
});

const NoteSchema = z.object({
  commitment: z.string(),
  ciphertext: z.string(),
  mint: z.string(),
  slot: z.number()
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

const BalanceDeltaSchema = z.object({
  mint: z.string(),
  delta: z.string()
});

const SnapshotSchema = z.object({
  roots: z.record(RootResponseSchema).default({}),
  nullifiers: z.record(z.array(z.string())).default({}),
  notes: z.record(z.array(NoteSchema)).default({}),
  balances: z.record(z.record(z.string())).default({})
});

type RootResponse = z.infer<typeof RootResponseSchema>;
type Note = z.infer<typeof NoteSchema>;
type SnapshotShape = z.infer<typeof SnapshotSchema>;

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
      this.state = snapshot;
      return;
    }
    const fixture = await this.tryRead(this.fixturePath);
    if (fixture) {
      this.state = fixture;
      return;
    }
    this.state = SnapshotSchema.parse({});
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
    return this.state?.roots[mint] ?? null;
  }

  getNullifiers(mint: string): string[] {
    return this.state?.nullifiers[mint] ?? [];
  }

  getNotes(viewKey: string): Note[] {
    return this.state?.notes[viewKey] ?? [];
  }

  getBalances(wallet: string): Record<string, string> {
    return { ...(this.state?.balances[wallet] ?? {}) };
  }

  upsertRoots(mint: string, payload: RootResponse): void {
    const state = this.ensureState();
    state.roots[mint] = payload;
  }

  upsertNotes(viewKey: string, notes: Note[]): void {
    const state = this.ensureState();
    state.notes[viewKey] = notes;
  }

  replaceNullifiers(mint: string, values: string[]): void {
    const state = this.ensureState();
    state.nullifiers[mint] = Array.from(new Set(values));
  }

  addNullifiers(mint: string, nullifiers: string[]): void {
    const state = this.ensureState();
    const existing = new Set(state.nullifiers[mint] ?? []);
    nullifiers.forEach((value) => existing.add(value));
    state.nullifiers[mint] = Array.from(existing);
  }

  applyBalanceDelta(wallet: string, mint: string, delta: string): Record<string, string> {
    const state = this.ensureState();
    const balances = { ...(state.balances[wallet] ?? {}) };
    let current = 0n;
    if (balances[mint]) {
      try {
        current = BigInt(balances[mint]!);
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
      delete balances[mint];
    } else {
      balances[mint] = next.toString();
    }
    if (Object.keys(balances).length === 0) {
      delete state.balances[wallet];
    } else {
      state.balances[wallet] = balances;
    }
    return balances;
  }
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
      return parsed.data;
    }
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'result' in payload &&
      typeof (payload as { result?: unknown }).result === 'object'
    ) {
      const nested = RootResponseSchema.safeParse((payload as { result: unknown }).result);
      if (nested.success) {
        return nested.data;
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
          store.upsertRoots(mint, remote);
          res.json({ mint, ...remote, source: 'upstream' });
          return;
        }
      }
      const local = store.getRoots(mint);
      if (!local) {
        res.status(404).json({ error: 'mint_not_found' });
        return;
      }
      res.json({ mint, ...local, source: upstreamClient ? 'cache' : 'snapshot' });
    } catch (error) {
      logger.error({ err: error, mint }, 'failed to resolve roots');
      res.status(502).json({ error: 'upstream_failed' });
    }
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
