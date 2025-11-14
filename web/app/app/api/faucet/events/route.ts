import { NextResponse } from 'next/server';
import { readFaucetEvents } from '../../../../lib/server/faucetLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const events = await readFaucetEvents();
    console.debug('[faucet] served events', { count: events.length });
    return NextResponse.json({ events });
  } catch (error) {
    console.error('[faucet] failed to read events', error);
    return NextResponse.json({ events: [], error: 'failed_to_read_events' }, { status: 500 });
  }
}

