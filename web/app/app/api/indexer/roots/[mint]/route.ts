import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import { commitmentToHex, decodeCommitmentTree } from '../../../../../lib/onchain/commitmentTree';
import { deriveCommitmentTree } from '../../../../../lib/onchain/pdas';

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
    const treeKey = deriveCommitmentTree(mintKey);
    const accountInfo = await connection.getAccountInfo(treeKey);
    if (!accountInfo) {
      return null;
    }
    const state = decodeCommitmentTree(new Uint8Array(accountInfo.data));
    return {
      current: commitmentToHex(state.currentRoot),
      recent: []
    };
  } catch {
    return null;
  }
}



