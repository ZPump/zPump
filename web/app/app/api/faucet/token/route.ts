import { NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { assertFaucetEnabled, createFaucetConnection, mintTokensToOwner } from '../../../../lib/server/faucet';
import { appendFaucetEvent } from '../../../../lib/server/faucetLog';

interface TokenRequestPayload {
  recipient?: string;
  mint?: string;
  amount?: string;
}

export async function POST(request: Request) {
  try {
    assertFaucetEnabled();
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message ?? 'Faucet disabled' },
      { status: 403 }
    );
  }

  let payload: TokenRequestPayload;
  try {
    payload = (await request.json()) as TokenRequestPayload;
  } catch {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  if (!payload.recipient || !payload.mint || !payload.amount) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  let amount: bigint;
  try {
    amount = BigInt(payload.amount);
  } catch {
    return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
  }
  if (amount <= 0n) {
    return NextResponse.json({ error: 'amount_must_be_positive' }, { status: 400 });
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
    return NextResponse.json({ signature });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message ?? 'mint_failed' },
      { status: 500 }
    );
  }
}


