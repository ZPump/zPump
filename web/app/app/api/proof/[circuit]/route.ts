'use server';

import { NextRequest, NextResponse } from 'next/server';

const INTERNAL_PROOF_URL =
  process.env.PROOF_RPC_INTERNAL_URL ?? 'http://127.0.0.1:8788/prove';

export async function POST(
  request: NextRequest,
  { params }: { params: { circuit: string } }
) {
  const circuit = params.circuit ?? '';
  const normalizedBase = INTERNAL_PROOF_URL.replace(/\/$/, '');
  const targetUrl = `${normalizedBase}/${circuit}`;

  try {
    const payload = await request.json();
    console.info('[proof-proxy] forwarding request', { circuit, targetUrl, payload });

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PROOF_RPC_API_KEY
          ? { 'x-ptf-api-key': process.env.PROOF_RPC_API_KEY }
          : {})
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    if (!response.ok) {
      console.error('[proof-proxy] upstream error', { status: response.status, text });
      return NextResponse.json(
        { error: 'proof_failed', message: text || response.statusText },
        { status: response.status }
      );
    }

    console.info('[proof-proxy] upstream success', { circuit, textLength: text.length });
    return new NextResponse(text, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[proof-proxy] unexpected error', error);
    return NextResponse.json(
      { error: 'proxy_failure', message: (error as Error).message },
      { status: 500 }
    );
  }
}

