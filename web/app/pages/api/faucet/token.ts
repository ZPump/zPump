import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import {
  assertFaucetEnabled,
  createFaucetConnection,
  mintTokensToOwner
} from '../../../lib/server/faucet';
import { appendFaucetEvent } from '../../../lib/server/faucetLog';

interface TokenRequestPayload {
  recipient?: string;
  mint?: string;
  amount?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    assertFaucetEnabled();
  } catch (error) {
    res.status(403).json({ error: (error as Error).message ?? 'faucet_disabled' });
    return;
  }

  const payload = (req.body ?? {}) as TokenRequestPayload;
  if (!payload.recipient || !payload.mint || !payload.amount) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }

  let amount: bigint;
  try {
    amount = BigInt(payload.amount);
  } catch {
    res.status(400).json({ error: 'invalid_amount' });
    return;
  }
  if (amount <= 0n) {
    res.status(400).json({ error: 'amount_must_be_positive' });
    return;
  }

  try {
    const connection = createFaucetConnection();
    const signature = await mintTokensToOwner(
      connection,
      new PublicKey(payload.recipient),
      new PublicKey(payload.mint),
      amount
    );
    await appendFaucetEvent({
      type: 'token',
      signature,
      amount: amount.toString(),
      mint: payload.mint,
      recipient: payload.recipient,
      timestamp: Date.now()
    });
    res.status(200).json({ signature });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message ?? 'mint_failed' });
  }
}


