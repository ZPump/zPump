'use server';

import type { NextApiRequest, NextApiResponse } from 'next';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/transfers/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {})
    });
    const payload = await response.json().catch(() => ({}));
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}


