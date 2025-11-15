import type { NextApiRequest, NextApiResponse } from 'next';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const viewKeyParam = req.query.viewKey;
  const viewKey = Array.isArray(viewKeyParam) ? viewKeyParam[0] : viewKeyParam;
  if (!viewKey) {
    res.status(400).json({ error: 'view_key_required' });
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/notes/${viewKey}`);
    const payload = await response.json().catch(() => ({}));
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}


