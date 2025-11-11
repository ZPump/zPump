import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import circomlibjs from 'circomlibjs';
import { groth16 } from 'snarkjs';
import pino from 'pino';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const API_KEY_HEADER = 'x-ptf-api-key';

interface VerifyingKeyConfig {
  circuit: string;
  version: string;
  path: string;
  wasm?: string;
  zkey?: string;
}

interface LoadedVerifyingKey extends VerifyingKeyConfig {
  hash: string;
  contents: string;
  verifyingKeyPath: string;
  wasmPath?: string | null;
  zkeyPath?: string | null;
  mode: 'mock' | 'groth16';
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

const ChangeSchema = z.object({
  amount: z.string().optional(),
  recipient: z.string().optional(),
  blinding: z.string().optional(),
  amountBlinding: z.string().optional()
});

const UnshieldInputSchema = z.object({
  oldRoot: z.string(),
  amount: z.string(),
  fee: z.string(),
  destPubkey: z.string(),
  mode: z.enum(['origin', 'ptkn', 'ztkn']),
  mintId: z.string(),
  poolId: z.string(),
  noteId: z.string(),
  noteAmount: z.string().optional(),
  spendingKey: z.string(),
  nullifier: z.string().optional(),
  change: ChangeSchema.optional()
});

type ShieldInput = z.infer<typeof ShieldInputSchema>;
type TransferInput = z.infer<typeof TransferInputSchema>;
type UnshieldInput = z.infer<typeof UnshieldInputSchema>;

const RootResponseSchema = z.object({
  current: z.string(),
  recent: z.array(z.string())
});

const NullifierResponseSchema = z.object({
  nullifiers: z.array(z.string())
});

type RootResponse = z.infer<typeof RootResponseSchema>;

const poseidon = circomlibjs.poseidon;

function bigIntify(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(value);
  }
  return BigInt(value);
}

function fieldToHex(value: bigint): string {
  const hex = value.toString(16);
  return `0x${hex.padStart(64, '0')}`;
}

function parsePubkeyField(value: string): bigint {
  try {
    const key = new PublicKey(value);
    const hex = Buffer.from(key.toBytes()).toString('hex');
    return BigInt(`0x${hex}`);
  } catch {
    return bigIntify(value);
  }
}

function poseidonValue(values: (string | number | bigint)[]): bigint {
  return poseidon(values.map(bigIntify));
}

function poseidonHex(values: (string | number | bigint)[]): string {
  return fieldToHex(poseidonValue(values));
}

function deriveShieldPublic(input: ShieldInput) {
  const commitmentValue = poseidonValue([
    input.amount,
    input.recipient,
    input.depositId,
    input.poolId,
    input.blinding
  ]);
  const commitment = fieldToHex(commitmentValue);
  const newRoot = poseidonHex([input.oldRoot, commitmentValue]);
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
    commitment,
    nullifiers: [] as string[]
  };
}

function deriveTransferPublic(input: TransferInput) {
  const nullifierValues = input.inNotes.map((note) =>
    poseidonValue([note.noteId, note.spendingKey])
  );
  const nullifiers = nullifierValues.map(fieldToHex);
  const outputs = input.outNotes.map((note) =>
    poseidonHex([note.amount, note.recipient, input.mintId, input.poolId, note.blinding])
  );
  const newRoot = poseidonHex([input.oldRoot, ...nullifierValues]);
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
  const nullifierValue = input.nullifier ? bigIntify(input.nullifier) : poseidonValue([input.noteId, input.spendingKey]);
  const nullifier = fieldToHex(nullifierValue);

  const amount = bigIntify(input.amount);
  const fee = bigIntify(input.fee);
  const noteAmount = input.noteAmount ? bigIntify(input.noteAmount) : amount + fee;
  const changeAmount = input.change?.amount ? bigIntify(input.change.amount) : noteAmount - (amount + fee);

  if (changeAmount < 0n) {
    throw new Error('change_amount_negative');
  }

  const hasChange = changeAmount > 0n;
  const changeRecipient = input.change?.recipient;
  const changeBlinding = input.change?.blinding;
  const changeAmountBlinding = input.change?.amountBlinding;

  if (hasChange) {
    if (!changeRecipient) {
      throw new Error('change_recipient_required');
    }
    if (!changeBlinding) {
      throw new Error('change_blinding_required');
    }
    if (!changeAmountBlinding) {
      throw new Error('change_amount_blinding_required');
    }
  }

  const changeCommitmentValue = hasChange
    ? poseidonValue([changeAmount, changeRecipient, input.mintId, input.poolId, changeBlinding])
    : 0n;

  const changeAmountCommitmentValue = hasChange
    ? poseidonValue([changeAmount, changeAmountBlinding])
    : 0n;

  const newRoot = poseidonHex([input.oldRoot, nullifierValue, changeCommitmentValue, changeAmountCommitmentValue]);

  const changeCommitment = fieldToHex(changeCommitmentValue);
  const changeAmountCommitment = fieldToHex(changeAmountCommitmentValue);

  const amountField = fieldToHex(amount);
  const feeField = fieldToHex(fee);
  const destField = fieldToHex(parsePubkeyField(input.destPubkey));
  const modeField = fieldToHex(input.mode === 'origin' ? 0n : 1n);
  const mintField = fieldToHex(parsePubkeyField(input.mintId));
  const poolField = fieldToHex(parsePubkeyField(input.poolId));

  return {
    publicInputs: [
      input.oldRoot,
      newRoot,
      nullifier,
      changeCommitment,
      changeAmountCommitment,
      amountField,
      feeField,
      destField,
      modeField,
      mintField,
      poolField
    ],
    newRoot,
    nullifiers: [nullifier],
    outputs: {
      changeCommitment,
      changeAmountCommitment,
      changeAmount: fieldToHex(changeAmount),
      noteAmount: fieldToHex(noteAmount)
    },
    payload: {
      ...input,
      noteAmount: noteAmount.toString(),
      change: hasChange
        ? {
            ...(input.change ?? {}),
            amount: changeAmount.toString(),
            recipient: changeRecipient,
            blinding: changeBlinding,
            amountBlinding: changeAmountBlinding
          }
        : { amount: '0', recipient: '0', blinding: '0', amountBlinding: '0' }
    }
  };
}

async function fileExists(target: string | undefined | null): Promise<boolean> {
  if (!target) {
    return false;
  }
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadVerifyingKeys(): Promise<LoadedVerifyingKey[]> {
  const configPath = path.join(__dirname, '..', 'config', 'verifying-keys.json');
  const raw = await fs.readFile(configPath, 'utf8');
  const entries = JSON.parse(raw) as VerifyingKeyConfig[];
  const base = process.env.VERIFYING_KEY_ROOT
    ? path.resolve(process.env.VERIFYING_KEY_ROOT)
    : path.join(__dirname, '..', '..', 'circuits', 'keys');
  const wasmBase = process.env.WASM_ROOT
    ? path.resolve(process.env.WASM_ROOT)
    : path.join(__dirname, '..', '..', 'circuits', 'wasm');
  const zkeyBase = process.env.ZKEY_ROOT
    ? path.resolve(process.env.ZKEY_ROOT)
    : base;

  const loadPromises = entries.map(async (entry) => {
    const verifyingKeyPath = path.resolve(base, path.basename(entry.path));
    const contents = await fs.readFile(verifyingKeyPath, 'utf8');
    const wasmPath = entry.wasm ? path.resolve(wasmBase, path.basename(entry.wasm)) : null;
    const zkeyPath = entry.zkey ? path.resolve(zkeyBase, path.basename(entry.zkey)) : null;
    const hasProver = (await fileExists(wasmPath)) && (await fileExists(zkeyPath));

    const loaded: LoadedVerifyingKey = {
      ...entry,
      path: entry.path,
      verifyingKeyPath,
      wasmPath,
      zkeyPath,
      contents,
      hash: hashString(contents),
      mode: hasProver ? 'groth16' : 'mock'
    };

    if (loaded.mode === 'groth16') {
      logger.info({ circuit: entry.circuit, wasmPath, zkeyPath }, 'Groth16 prover enabled');
    } else {
      logger.warn({ circuit: entry.circuit }, 'Groth16 artifacts missing, using mock proofs');
    }

    return loaded;
  });

  return Promise.all(loadPromises);
}

class IndexerClient {
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
      throw new Error(`indexer status ${response.status}`);
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
    throw new Error('unexpected indexer root payload');
  }

  async getNullifiers(mint: string): Promise<Set<string>> {
    const payload = await this.request<unknown>(`/nullifiers/${mint}`);
    if (!payload) {
      return new Set();
    }
    const parsed = NullifierResponseSchema.safeParse(payload);
    if (parsed.success) {
      return new Set(parsed.data.nullifiers);
    }
    if (Array.isArray(payload) && payload.every((value) => typeof value === 'string')) {
      return new Set(payload);
    }
    throw new Error('unexpected indexer nullifier payload');
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

async function validateAgainstIndexer(
  client: IndexerClient | null,
  mint: string,
  oldRoot: string,
  nullifiers: string[]
): Promise<void> {
  if (!client || !mint || mint === '0') {
    return;
  }
  const roots = await client.getRoots(mint);
  if (!roots) {
    throw new Error('unknown_mint');
  }
  const known = new Set([roots.current, ...roots.recent]);
  if (!known.has(oldRoot)) {
    throw new Error('unknown_root');
  }
  if (nullifiers.length === 0) {
    return;
  }
  const used = await client.getNullifiers(mint);
  for (const nullifier of nullifiers) {
    if (used.has(nullifier)) {
      throw new Error(`nullifier_reused:${nullifier}`);
    }
  }
}

async function produceProof(
  entry: LoadedVerifyingKey,
  circuit: ProofRequestPayload['circuit'],
  payload: unknown,
  derivedInputs: string[]
): Promise<{ proof: string; publicInputs: string[]; verifyingKeyHash: string }> {
  if (entry.mode === 'groth16' && entry.wasmPath && entry.zkeyPath) {
    try {
      const { proof, publicSignals } = await groth16.fullProve(payload, entry.wasmPath, entry.zkeyPath);
      const normalisedSignals = Array.isArray(publicSignals)
        ? publicSignals.map((value) => value.toString())
        : [];
      const finalInputs = normalisedSignals.length === derivedInputs.length ? normalisedSignals : derivedInputs;
      if (normalisedSignals.length !== derivedInputs.length) {
        logger.warn({ circuit }, 'Groth16 public signal length mismatch, using derived inputs');
      }
      return {
        proof: Buffer.from(JSON.stringify(proof)).toString('base64'),
        publicInputs: finalInputs,
        verifyingKeyHash: entry.hash
      };
    } catch (error) {
      logger.warn({ err: error, circuit }, 'Groth16 proving failed, falling back to mock proof');
    }
  }

  return {
    proof: mockProof(circuit, payload, entry.hash),
    publicInputs: derivedInputs,
    verifyingKeyHash: entry.hash
  };
}

async function generateProof(
  request: ProofRequestPayload,
  verifyingKeys: LoadedVerifyingKey[],
  indexer: IndexerClient | null
): Promise<{ proof: string; publicInputs: string[]; verifyingKeyHash: string }> {
  const entry = verifyingKeys.find((item) => item.circuit === request.circuit);
  if (!entry) {
    throw new Error(`No verifying key registered for circuit ${request.circuit}`);
  }

  switch (request.circuit) {
    case 'shield': {
      const payload = ShieldInputSchema.parse(request.payload);
      const derived = deriveShieldPublic(payload);
      await validateAgainstIndexer(indexer, payload.mintId, payload.oldRoot, derived.nullifiers);
      return produceProof(entry, request.circuit, payload, derived.publicInputs);
    }
    case 'transfer': {
      const payload = TransferInputSchema.parse(request.payload);
      const derived = deriveTransferPublic(payload);
      await validateAgainstIndexer(indexer, payload.mintId, payload.oldRoot, derived.nullifiers);
      return produceProof(entry, request.circuit, payload, derived.publicInputs);
    }
    case 'unshield': {
      const payload = UnshieldInputSchema.parse(request.payload);
      const derived = deriveUnshieldPublic(payload);
      await validateAgainstIndexer(indexer, payload.mintId, payload.oldRoot, derived.nullifiers);
      return produceProof(entry, request.circuit, derived.payload, derived.publicInputs);
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
  const indexerClient = process.env.INDEXER_URL
    ? new IndexerClient(process.env.INDEXER_URL, process.env.INDEXER_API_KEY ?? process.env.API_KEY)
    : null;
  const apiKey = process.env.PROOF_RPC_API_KEY ?? process.env.API_KEY ?? null;

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));

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
    res.json({ ok: true, circuits: verifyingKeys.map((entry) => entry.circuit), indexer: Boolean(indexerClient) });
  });

  app.post('/prove/:circuit', async (req, res) => {
    try {
      const circuit = req.params.circuit as ProofRequestPayload['circuit'];
      const request = ProofRequestSchema.parse({ circuit, payload: req.body });
      const proof = await generateProof(request, verifyingKeys, indexerClient);
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
