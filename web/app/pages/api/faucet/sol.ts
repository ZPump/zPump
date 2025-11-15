import type { NextApiRequest, NextApiResponse } from 'next';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  assertFaucetEnabled,
  createFaucetConnection,
  requestAirDrop
} from '../../../lib/server/faucet';
import { appendFaucetEvent } from '../../../lib/server/faucetLog';

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

  const payload = (req.body ?? {}) as { recipient?: string; amountLamports?: string };
  if (!payload.recipient) {
    res.status(400).json({ error: 'recipient_required' });
    return;
  }

  const amountStr = payload.amountLamports ?? LAMPORTS_PER_SOL.toString();
  let lamports: bigint;
  try {
    lamports = BigInt(amountStr);
  } catch {
    res.status(400).json({ error: 'invalid_amount' });
    return;
  }
  if (lamports <= 0n) {
    res.status(400).json({ error: 'amount_must_be_positive' });
    return;
  }
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    res.status(400).json({ error: 'amount_too_large' });
    return;
  }

  try {
    const connection = createFaucetConnection();
    const recipient = new PublicKey(payload.recipient);
    const signature = await requestAirDrop(connection, recipient, lamports);
    await appendFaucetEvent({
      type: 'sol',
      signature,
      amount: lamports.toString(),
      mint: null,
      recipient: recipient.toBase58(),
      timestamp: Date.now()
    });
    res.status(200).json({ signature });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message ?? 'airdrop_failed' });
  }
}


