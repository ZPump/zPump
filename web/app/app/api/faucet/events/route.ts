'use server';

import { NextResponse } from 'next/server';
import { readFaucetEvents } from '../../../../lib/server/faucetLog';

export async function GET() {
  const events = await readFaucetEvents();
  return NextResponse.json({ events });
}

