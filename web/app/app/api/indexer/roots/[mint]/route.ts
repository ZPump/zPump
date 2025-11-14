import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState } from '../../../../../lib/onchain/pdas';
import { bytesLEToCanonicalHex, canonicalizeHex } from '../../../../../lib/onchain/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';
const RPC_INTERNAL_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

export async function GET(request: Request, context: { params: { mint: string } }) {
  const { mint } = context.params;
  const url = new URL(request.url);
  const preferSource = url.searchParams.get('source');
  const preferChain = preferSource === 'chain';

  if (preferChain) {
    const fallback = await fetchRootFromChain(mint);
    if (fallback) {
      return NextResponse.json({ mint, ...fallback, source: 'chain' });
    }
    return NextResponse.json({ error: 'chain_unavailable' }, { status: 502 });
  }

  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/roots/${mint}`);
    if (!response.ok) {
      const fallback = await fetchRootFromChain(mint);
      if (fallback) {
        return NextResponse.json({ mint, ...fallback, source: 'chain' });
      }
      const payload = await response.json().catch(() => ({}));
      return NextResponse.json(payload, { status: response.status });
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const fallback = await fetchRootFromChain(mint);
    if (fallback) {
      return NextResponse.json({ mint, ...fallback, source: 'chain' });
    }
    return NextResponse.json({ error: (error as Error).message ?? 'indexer_unreachable' }, { status: 502 });
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
    return {
      current,
      recent
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: { params: { mint: string } }) {
  const { mint } = context.params;
  try {
    const payload = await request.json();
    const response = await fetch(`${INDEXER_INTERNAL_URL}/roots/${mint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
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
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message ?? 'indexer_unreachable' }, { status: 502 });
  }
}



