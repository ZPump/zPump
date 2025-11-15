'use server';

import type { NextApiRequest, NextApiResponse } from 'next';

const CONFIGURED_INTERNAL_URL =
  process.env.PROOF_RPC_INTERNAL_URL ?? 'http://127.0.0.1:8788/prove';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const segments = req.query.segments;
  const normalizedSegments = Array.isArray(segments)
    ? segments
    : typeof segments === 'string'
      ? [segments]
      : [];

  if (normalizedSegments.length === 0) {
    res.status(404).json({ error: 'invalid_request', message: 'Proof circuit path missing' });
    return;
  }

  const targetUrl = buildTargetUrl(normalizedSegments);

  try {
    const payload = req.body ?? {};
    console.info('[proof-proxy] forwarding request', { segments: normalizedSegments, targetUrl, payload });

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
      res.status(response.status).json({ error: 'proof_failed', message: text || response.statusText });
      return;
    }

    console.info('[proof-proxy] upstream success', {
      segments: normalizedSegments,
      textLength: text.length
    });
    res.status(response.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (error) {
    console.error('[proof-proxy] unexpected error', error);
    res.status(500).json({ error: 'proxy_failure', message: (error as Error).message });
  }
}

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


