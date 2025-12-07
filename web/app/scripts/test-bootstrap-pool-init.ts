import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState } from '../lib/onchain/pdas';

async function test() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  const poolState = derivePoolState(wsolMint);
  
  const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
  if (poolAccount && poolAccount.data.length >= 72) {
    const data = Buffer.from(poolAccount.data);
    const originMint = new PublicKey(data.slice(40, 72));
    console.log('Pool exists!');
    console.log(`  Origin mint: ${originMint.toBase58()}`);
    console.log(`  Expected: ${wsolMint.toBase58()}`);
    console.log(`  Match: ${originMint.equals(wsolMint)}`);
  } else {
    console.log('Pool does not exist');
  }
}

test().catch(console.error);
