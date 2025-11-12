'use server';

import { NextRequest, NextResponse } from 'next/server';

const CONFIGURED_INTERNAL_URL =
  process.env.PROOF_RPC_INTERNAL_URL ?? 'http://127.0.0.1:8788/prove';

function buildTargetUrl(requestSegments: string[]) {
  try {
    const url = new URL(CONFIGURED_INTERNAL_URL);
    const basePathSegments = url.pathname.split('/').filter(Boolean);
    const normalizedSegments = [...requestSegments];

    if (
      normalizedSegments.length > 0 &&
      basePathSegments.length > 0 &&
      basePathSegments[basePathSegments.length - 1] === normalizedSegments[0]
    ) {
      normalizedSegments.shift();
    }

    const path = [...basePathSegments, ...normalizedSegments].filter(Boolean).join('/');
    return `${url.origin}/${path}`;
  } catch {
    const origin = CONFIGURED_INTERNAL_URL.replace(/\/$/, '');
    const path = requestSegments.filter(Boolean).join('/');
    return `${origin}/${path}`;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { segments?: string[] } }
) {
  const segments = params.segments ?? [];

  if (segments.length === 0) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Proof circuit path missing' },
      { status: 404 }
    );
  }

  const targetUrl = buildTargetUrl(segments);

  try {
    const payload = await request.json();
    console.info('[proof-proxy] forwarding request', { segments, targetUrl, payload });

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PROOF_RPC_API_KEY ? { 'x-ptf-api-key': process.env.PROOF_RPC_API_KEY } : {})
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

    console.info('[proof-proxy] upstream success', { segments, textLength: text.length });
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

