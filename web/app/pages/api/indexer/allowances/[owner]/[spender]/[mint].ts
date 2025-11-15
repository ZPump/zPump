import type { NextApiRequest, NextApiResponse } from 'next';

const INDEXER_INTERNAL_URL = process.env.INDEXER_INTERNAL_URL ?? 'http://127.0.0.1:8787';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ownerParam = req.query.owner;
  const spenderParam = req.query.spender;
  const mintParam = req.query.mint;
  const owner = Array.isArray(ownerParam) ? ownerParam[0] : ownerParam;
  const spender = Array.isArray(spenderParam) ? spenderParam[0] : spenderParam;
  const mint = Array.isArray(mintParam) ? mintParam[0] : mintParam;

  if (!owner || !spender || !mint) {
    res.status(400).json({ error: 'owner_spender_mint_required' });
    return;
  }

  if (req.method === 'GET') {
    await proxyGet(owner, spender, mint, res);
    return;
  }

  if (req.method === 'POST') {
    await proxyPost(owner, spender, mint, req, res);
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: 'method_not_allowed' });
}

async function proxyGet(owner: string, spender: string, mint: string, res: NextApiResponse) {
  try {
    const response = await fetch(`${INDEXER_INTERNAL_URL}/allowances/${owner}/${spender}/${mint}`);
    if (response.status === 404) {
      res.status(404).json({ error: 'allowance_not_found' });
      return;
    }
    const payload = await response.json().catch(() => ({}));
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}

async function proxyPost(
  owner: string,
  spender: string,
  mint: string,
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const amount =
      typeof req.body?.amount === 'string'
        ? req.body.amount
        : Array.isArray(req.body?.amount)
          ? req.body.amount[0]
          : undefined;
    if (!amount) {
      res.status(400).json({ error: 'amount_required' });
      return;
    }
    const response = await fetch(`${INDEXER_INTERNAL_URL}/allowances/${owner}/${spender}/${mint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    const payload = await response.json().catch(() => ({}));
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({ error: (error as Error).message ?? 'indexer_unreachable' });
  }
}


