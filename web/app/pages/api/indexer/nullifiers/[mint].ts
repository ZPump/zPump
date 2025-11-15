import type { NextApiRequest, NextApiResponse } from 'next';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const mintParam = req.query.mint;
  const mint = Array.isArray(mintParam) ? mintParam[0] : mintParam;
  if (!mint) {
    res.status(400).json({ error: 'mint_required' });
    return;
  }

  if (req.method === 'GET') {
    await proxyIndexer(`${INDEXER_INTERNAL_URL}/nullifiers/${mint}`, res);
    return;
  }

  if (req.method === 'POST') {
    await proxyIndexer(`${INDEXER_INTERNAL_URL}/nullifiers/${mint}`, res, req.body ?? {});
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: 'method_not_allowed' });
}

async function proxyIndexer(url: string, res: NextApiResponse, body?: unknown) {
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}


