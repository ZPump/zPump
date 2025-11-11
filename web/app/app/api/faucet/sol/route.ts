import { NextResponse } from 'next/server';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  assertFaucetEnabled,
  createFaucetConnection,
  requestAirDrop
} from '../../../../lib/server/faucet';

export async function POST(request: Request) {
  try {
    assertFaucetEnabled();
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message ?? 'Faucet disabled' },
      { status: 403 }
    );
  }

  let payload: { recipient?: string; amountLamports?: string } = {};
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  if (!payload.recipient) {
    return NextResponse.json({ error: 'recipient_required' }, { status: 400 });
  }

  const amountStr = payload.amountLamports ?? LAMPORTS_PER_SOL.toString();
  let lamports: bigint;
  try {
    lamports = BigInt(amountStr);
  } catch {
    return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
  }
  if (lamports <= 0n) {
    return NextResponse.json({ error: 'amount_must_be_positive' }, { status: 400 });
  }
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    return NextResponse.json({ error: 'amount_too_large' }, { status: 400 });
  }

  try {
    const connection = createFaucetConnection();
    const recipient = new PublicKey(payload.recipient);
    const signature = await requestAirDrop(connection, recipient, lamports);
    return NextResponse.json({ signature });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message ?? 'airdrop_failed' },
      { status: 500 }
    );
  }
}


