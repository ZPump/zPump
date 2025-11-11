import { NextResponse } from 'next/server';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';

export async function GET(_request: Request, context: { params: { mint: string } }) {
  const { mint } = context.params;
  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/nullifiers/${mint}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return NextResponse.json(payload, { status: response.status });
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message ?? 'indexer_unreachable' }, { status: 502 });
  }
}

export async function POST(request: Request, context: { params: { mint: string } }) {
  const { mint } = context.params;
  try {
    const body = await request.json();
    const response = await fetch(`${INDEXER_INTERNAL_URL}/nullifiers/${mint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return NextResponse.json(payload, { status: response.status });
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message ?? 'indexer_unreachable' }, { status: 502 });
  }
}


