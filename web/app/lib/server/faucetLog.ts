import fs from 'fs/promises';
import path from 'path';

export interface FaucetEvent {
  type: 'sol' | 'token';
  recipient: string;
  signature: string;
  amount: string;
  mint: string | null;
  timestamp: number;
}

const MAX_EVENTS = 25;
const CURRENT_PATH = process.env.FAUCET_LOG_PATH
  ? path.resolve(process.env.FAUCET_LOG_PATH)
  : path.join(process.cwd(), 'faucet-events.json');
const LEGACY_PATH = path.join(process.cwd(), '..', '..', 'faucet-events.json');

async function ensureFile(): Promise<void> {
  try {
    await fs.access(CURRENT_PATH);
  } catch {
    try {
      await fs.access(LEGACY_PATH);
      await fs.copyFile(LEGACY_PATH, CURRENT_PATH);
      return;
    } catch {
      // legacy missing; create fresh file
    }
    await fs.writeFile(CURRENT_PATH, '[]', 'utf8');
  }
}

export async function appendFaucetEvent(event: FaucetEvent): Promise<void> {
  await ensureFile();
  const raw = await fs.readFile(CURRENT_PATH, 'utf8');
  let events: FaucetEvent[];
  try {
    events = JSON.parse(raw) as FaucetEvent[];
  } catch {
    events = [];
  }
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events = events.slice(0, MAX_EVENTS);
  }
  await fs.writeFile(CURRENT_PATH, JSON.stringify(events), 'utf8');
}

export async function readFaucetEvents(): Promise<FaucetEvent[]> {
  await ensureFile();
  const raw = await fs.readFile(CURRENT_PATH, 'utf8');
  try {
    return JSON.parse(raw) as FaucetEvent[];
  } catch {
    return [];
  }
}

