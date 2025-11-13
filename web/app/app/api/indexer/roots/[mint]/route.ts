import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState } from '../../../../../lib/onchain/pdas';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';
const RPC_INTERNAL_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

export async function GET(_request: Request, context: { params: { mint: string } }) {
  const { mint } = context.params;
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
    const current = `0x${Array.from(currentRootRaw)
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')}`;
    const maxRoots = 16;
    const recentOffset = currentRootOffset + 32;
    const rootsLenOffset = recentOffset + 32 * maxRoots;
    const rootsLen = data[rootsLenOffset] ?? 0;
    const recent: string[] = [];
    for (let idx = 0; idx < Math.min(rootsLen, maxRoots); idx += 1) {
      const start = recentOffset + idx * 32;
      const rootRaw = data.slice(start, start + 32);
      recent.push(
        `0x${Array.from(rootRaw)
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')}`
      );
    }
    return {
      current,
      recent
    };
  } catch {
    return null;
  }
}



