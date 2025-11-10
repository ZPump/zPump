import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { sha256 } from '@noble/hashes/sha256';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface VerifyingKeyConfig {
  circuit: string;
  version: string;
  path: string;
}

interface LoadedVerifyingKey extends VerifyingKeyConfig {
  hash: string;
  contents: string;
}

const ProofRequestSchema = z.object({
  circuit: z.enum(['shield', 'transfer', 'unshield']),
  payload: z.record(z.any())
});

type ProofRequestPayload = z.infer<typeof ProofRequestSchema>;

const ShieldInputSchema = z.object({
  oldRoot: z.string(),
  amount: z.string(),
  recipient: z.string(),
  depositId: z.string(),
  poolId: z.string(),
  blinding: z.string(),
  mintId: z.string().optional().default('0')
});

const TransferInputSchema = z.object({
  oldRoot: z.string(),
  mintId: z.string(),
  poolId: z.string(),
  inNotes: z
    .array(
      z.object({
        noteId: z.string(),
        spendingKey: z.string(),
        amount: z.string()
      })
    )
    .min(1),
  outNotes: z
    .array(
      z.object({
        amount: z.string(),
        recipient: z.string(),
        blinding: z.string()
      })
    )
    .min(1)
});

const UnshieldInputSchema = z.object({
  oldRoot: z.string(),
  amount: z.string(),
  fee: z.string(),
  destPubkey: z.string(),
  mode: z.enum(['origin', 'ptkn']),
  mintId: z.string(),
  poolId: z.string(),
  noteId: z.string(),
  spendingKey: z.string()
});

type ShieldInput = z.infer<typeof ShieldInputSchema>;
type TransferInput = z.infer<typeof TransferInputSchema>;
type UnshieldInput = z.infer<typeof UnshieldInputSchema>;

function hashString(data: string): string {
  const digest = sha256(Buffer.from(data));
  return `0x${Buffer.from(digest).toString('hex')}`;
}

function hashMany(values: (string | bigint)[]): string {
  const normalised = values.map((value) => BigInt(value).toString()).join(':');
  return hashString(normalised);
}

function deriveShieldPublic(input: ShieldInput) {
  const commitment = hashMany([
    input.amount,
    input.recipient,
    input.depositId,
    input.poolId,
    input.blinding
  ]);
  const newRoot = hashMany([input.oldRoot, commitment]);
  return {
    publicInputs: [
      input.oldRoot,
      newRoot,
      commitment,
      input.mintId,
      input.poolId,
      input.depositId
    ],
    newRoot,
    commitment
  };
}

function deriveTransferPublic(input: TransferInput) {
  const nullifiers = input.inNotes.map((note) => hashMany([note.noteId, note.spendingKey]));
  const outputs = input.outNotes.map((note, index) =>
    hashMany([note.amount, note.recipient, input.mintId, input.poolId, note.blinding])
  );
  const newRoot = hashMany([input.oldRoot, ...nullifiers]);
  return {
    publicInputs: [
      input.oldRoot,
      newRoot,
      ...nullifiers,
      ...outputs,
      input.mintId,
      input.poolId
    ],
    newRoot,
    nullifiers,
    outputs
  };
}

function deriveUnshieldPublic(input: UnshieldInput) {
  const nullifier = hashMany([input.noteId, input.spendingKey]);
  const newRoot = hashMany([input.oldRoot, nullifier]);
  return {
    publicInputs: [
      input.oldRoot,
      newRoot,
      nullifier,
      input.amount,
      input.fee,
      input.destPubkey,
      input.mode === 'origin' ? '0' : '1',
      input.mintId,
      input.poolId
    ],
    newRoot,
    nullifier
  };
}

async function loadVerifyingKeys(): Promise<LoadedVerifyingKey[]> {
  const configPath = path.join(__dirname, '..', 'config', 'verifying-keys.json');
  const raw = await fs.readFile(configPath, 'utf8');
  const entries = JSON.parse(raw) as VerifyingKeyConfig[];
  const base = process.env.VERIFYING_KEY_ROOT
    ? path.resolve(process.env.VERIFYING_KEY_ROOT)
    : path.join(__dirname, '..', '..', 'circuits', 'keys');

  const loadPromises = entries.map(async (entry) => {
    const resolved = path.resolve(base, path.basename(entry.path));
    const contents = await fs.readFile(resolved, 'utf8');
    return {
      ...entry,
      path: resolved,
      contents,
      hash: hashString(contents)
    } satisfies LoadedVerifyingKey;
  });

  return Promise.all(loadPromises);
}

async function generateProof(
  request: ProofRequestPayload,
  verifyingKeys: LoadedVerifyingKey[]
): Promise<{ proof: string; publicInputs: string[]; verifyingKeyHash: string }> {
  const vk = verifyingKeys.find((entry) => entry.circuit === request.circuit);
  if (!vk) {
    throw new Error(`No verifying key registered for circuit ${request.circuit}`);
  }

  switch (request.circuit) {
    case 'shield': {
      const payload = ShieldInputSchema.parse(request.payload);
      const derived = deriveShieldPublic(payload);
      return {
        proof: mockProof(request.circuit, payload, vk.hash),
        publicInputs: derived.publicInputs,
        verifyingKeyHash: vk.hash
      };
    }
    case 'transfer': {
      const payload = TransferInputSchema.parse(request.payload);
      const derived = deriveTransferPublic(payload);
      return {
        proof: mockProof(request.circuit, payload, vk.hash),
        publicInputs: derived.publicInputs,
        verifyingKeyHash: vk.hash
      };
    }
    case 'unshield': {
      const payload = UnshieldInputSchema.parse(request.payload);
      const derived = deriveUnshieldPublic(payload);
      return {
        proof: mockProof(request.circuit, payload, vk.hash),
        publicInputs: derived.publicInputs,
        verifyingKeyHash: vk.hash
      };
    }
  }
}

function mockProof(circuit: string, payload: unknown, verifyingKeyHash: string): string {
  const blob = JSON.stringify({ circuit, payload, verifyingKeyHash });
  const digest = sha256(Buffer.from(blob));
  return Buffer.from(digest).toString('base64');
}

async function main() {
  const app = express();
  const port = Number(process.env.PORT ?? 8788);
  const verifyingKeys = await loadVerifyingKeys();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, circuits: verifyingKeys.map((entry) => entry.circuit) });
  });

  app.post('/prove/:circuit', async (req, res) => {
    try {
      const circuit = req.params.circuit as ProofRequestPayload['circuit'];
      const request = ProofRequestSchema.parse({ circuit, payload: req.body });
      const proof = await generateProof(request, verifyingKeys);
      res.json(proof);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'invalid_payload', details: error.flatten() });
        return;
      }
      res.status(500).json({ error: 'proof_failed', message: (error as Error).message });
    }
  });

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Proof RPC listening on ${port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to boot Proof RPC', error);
    process.exit(1);
  });
}
