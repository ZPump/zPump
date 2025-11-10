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

type RootResponse = z.infer<typeof RootResponseSchema>;
type Note = z.infer<typeof NoteSchema>;

interface SnapshotShape {
  roots: Record<string, RootResponse>;
  nullifiers: Record<string, string[]>;
  notes: Record<string, Note[]>;
}

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
    if (!fixture) {
      throw new Error('Unable to load indexer snapshot or fixture');
    }
    this.state = fixture;
  }

  async tryRead(target: string): Promise<SnapshotShape | null> {
    try {
      const contents = await fs.readFile(target, 'utf8');
      return JSON.parse(contents) as SnapshotShape;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.warn({ err: error }, `Failed to read ${target}`);
      return null;
    }
  }

  async persist(): Promise<void> {
    if (!this.state) {
      return;
    }
    await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.writeFile(this.snapshotPath, JSON.stringify(this.state, null, 2));
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

  upsertRoots(mint: string, payload: RootResponse): void {
    if (!this.state) {
      throw new Error('state not initialised');
    }
    this.state.roots[mint] = payload;
  }

  upsertNotes(viewKey: string, notes: Note[]): void {
    if (!this.state) {
      throw new Error('state not initialised');
    }
    this.state.notes[viewKey] = notes;
  }

  addNullifiers(mint: string, nullifiers: string[]): void {
    if (!this.state) {
      throw new Error('state not initialised');
    }
    const existing = new Set(this.state.nullifiers[mint] ?? []);
    nullifiers.forEach((value) => existing.add(value));
    this.state.nullifiers[mint] = Array.from(existing);
  }
}

async function bootstrap() {
  const app = express();
  const port = Number(process.env.PORT ?? 8787);
  const store = new StateStore();
  await store.load();

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

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/roots/:mint', (req, res) => {
    const mint = req.params.mint;
    const roots = store.getRoots(mint);
    if (!roots) {
      res.status(404).json({ error: 'mint_not_found' });
      return;
    }
    res.json({ mint, ...roots });
  });

  app.get('/nullifiers/:mint', (req, res) => {
    const mint = req.params.mint;
    const nullifiers = store.getNullifiers(mint);
    res.json({ mint, nullifiers });
  });

  app.get('/notes/:viewKey', (req, res) => {
    const viewKey = req.params.viewKey;
    const notes = store.getNotes(viewKey);
    res.json({ viewKey, notes });
  });

  const server = app.listen(port, () => {
    logger.info({ port }, 'Photon indexer listening');
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
