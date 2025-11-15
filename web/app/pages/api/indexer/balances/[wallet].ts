import type { NextApiRequest, NextApiResponse } from 'next';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const walletParam = req.query.wallet;
  const wallet = Array.isArray(walletParam) ? walletParam[0] : walletParam;
  if (!wallet) {
    res.status(400).json({ error: 'wallet_required' });
    return;
  }

  if (req.method === 'GET') {
    await handleGet(wallet, res);
    return;
  }

  if (req.method === 'POST') {
    await handlePost(wallet, req, res);
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: 'method_not_allowed' });
}

async function handleGet(wallet: string, res: NextApiResponse) {
  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/balances/${wallet}`);
    const payload = await response.json().catch(() => ({}));
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}

async function handlePost(wallet: string, req: NextApiRequest, res: NextApiResponse) {
  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/balances/${wallet}`, {
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


