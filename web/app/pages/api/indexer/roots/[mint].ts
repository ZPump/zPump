import type { NextApiRequest, NextApiResponse } from 'next';
import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState } from '../../../../lib/onchain/pdas';
import { bytesLEToCanonicalHex, canonicalizeHex } from '../../../../lib/onchain/utils';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';
const RPC_INTERNAL_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const mintParam = req.query.mint;
  const mint = Array.isArray(mintParam) ? mintParam[0] : mintParam;
  if (!mint) {
    res.status(400).json({ error: 'mint_required' });
    return;
  }

  if (req.method === 'GET') {
    await handleGet(req, res, mint);
    return;
  }

  if (req.method === 'POST') {
    await handlePost(req, res, mint);
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: 'method_not_allowed' });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse, mint: string) {
  const preferSource = typeof req.query.source === 'string' ? req.query.source : undefined;
  const preferChain = preferSource === 'chain';

  if (preferChain) {
    const fallback = await fetchRootFromChain(mint);
    if (fallback) {
      res.status(200).json({ mint, ...fallback, source: 'chain' });
      return;
    }
    res.status(502).json({ error: 'chain_unavailable' });
    return;
  }

  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/roots/${mint}`);
    if (!response.ok) {
      const fallback = await fetchRootFromChain(mint);
      if (fallback) {
        res.status(200).json({ mint, ...fallback, source: 'chain' });
        return;
      }
      const payload = await response.json().catch(() => ({}));
      res.status(response.status).json(payload);
      return;
    }
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    const fallback = await fetchRootFromChain(mint);
    if (fallback) {
      res.status(200).json({ mint, ...fallback, source: 'chain' });
      return;
    }
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, mint: string) {
  try {
    const payload = req.body ?? {};
    const response = await fetch(`${INDEXER_INTERNAL_URL}/roots/${mint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current: canonicalizeHex(payload.current ?? '0x0'),
        recent: Array.isArray(payload.recent)
          ? payload.recent
              .filter((entry: unknown): entry is string => typeof entry === 'string')
              .map((entry: string) => canonicalizeHex(entry))
          : []
      })
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}

async function fetchRootFromChain(mint: string) {
  try {
    const connection = new Connection(RPC_INTERNAL_URL, 'confirmed');
    const mintKey = new PublicKey(mint);
    const poolKey = derivePoolState(mintKey);
    const accountInfo = await connection.getAccountInfo(poolKey);
    if (!accountInfo) {
      return null;
    }
    const data = new Uint8Array(accountInfo.data);
    const base = 8;
    const currentRootOffset = base + 32 * 8;
    const currentRootRaw = data.slice(currentRootOffset, currentRootOffset + 32);
    const current = bytesLEToCanonicalHex(currentRootRaw);
    const maxRoots = 16;
    const recentOffset = currentRootOffset + 32;
    const rootsLenOffset = recentOffset + 32 * maxRoots;
    const rootsLen = data[rootsLenOffset] ?? 0;
    const recent: string[] = [];
    for (let idx = 0; idx < Math.min(rootsLen, maxRoots); idx += 1) {
      const start = recentOffset + idx * 32;
      const rootRaw = data.slice(start, start + 32);
      recent.push(bytesLEToCanonicalHex(rootRaw));
    }
    return { current, recent };
  } catch {
    return null;
  }
}


