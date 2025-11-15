import type { NextApiRequest, NextApiResponse } from 'next';
import { readFaucetEvents } from '../../../lib/server/faucetLog';

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const events = await readFaucetEvents();
    console.debug('[faucet] served events', { count: events.length });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ events });
  } catch (error) {
    console.error('[faucet] failed to read events', error);
    res.status(500).json({ events: [], error: 'failed_to_read_events' });
  }
}


