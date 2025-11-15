import type { NextApiRequest, NextApiResponse } from 'next';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const viewParam = req.query.viewId;
  const viewId = Array.isArray(viewParam) ? viewParam[0] : viewParam;
  if (!viewId) {
    res.status(400).json({ error: 'view_id_required' });
    return;
  }

  if (req.method === 'GET') {
    await proxyGet(viewId, res);
    return;
  }

  if (req.method === 'POST') {
    await proxyPost(viewId, req, res);
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: 'method_not_allowed' });
}

async function proxyGet(viewId: string, res: NextApiResponse) {
  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/activity/${viewId}`);
    const payload = await response.json().catch(() => ({}));
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}

async function proxyPost(viewId: string, req: NextApiRequest, res: NextApiResponse) {
  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/activity/${viewId}`, {
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

