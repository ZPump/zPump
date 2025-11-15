import type { NextApiRequest, NextApiResponse } from 'next';
import {
  appendWalletActivityEntry,
  getWalletActivityEntries,
  WalletActivityRecord,
  WalletActivityType
} from '../../../lib/server/activityLog';
import { WALLET_ACTIVITY_MODE } from '../../../lib/env';

function validateType(value: unknown): value is WalletActivityType {
  return value === 'wrap' || value === 'unwrap';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const walletParam = req.query.wallet;
  const wallet = Array.isArray(walletParam) ? walletParam[0] : walletParam;

  if (!wallet || typeof wallet !== 'string') {
    res.status(400).json({ error: 'wallet_required' });
    return;
  }

  if (WALLET_ACTIVITY_MODE !== 'local') {
    res.status(404).json({ error: 'activity_log_disabled' });
    return;
  }

  if (req.method === 'GET') {
    const entries = await getWalletActivityEntries(wallet);
    res.status(200).json({ entries });
    return;
  }

  if (req.method === 'POST') {
    const { id, type, signature, symbol, amount, timestamp } = req.body ?? {};
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'id_required' });
      return;
    }
    if (!validateType(type)) {
      res.status(400).json({ error: 'invalid_type' });
      return;
    }
    if (!signature || typeof signature !== 'string') {
      res.status(400).json({ error: 'signature_required' });
      return;
    }
    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({ error: 'symbol_required' });
      return;
    }
    if (!amount || typeof amount !== 'string') {
      res.status(400).json({ error: 'amount_required' });
      return;
    }
    const normalizedTimestamp =
      typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();

    const entry: WalletActivityRecord = {
      id,
      wallet,
      type,
      signature,
      symbol,
      amount,
      timestamp: normalizedTimestamp
    };

    await appendWalletActivityEntry(entry);
    res.status(200).json({ entry });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: 'method_not_allowed' });
}

