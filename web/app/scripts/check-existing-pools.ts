import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState } from '../lib/onchain/pdas';

async function check() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  
  const poolState = derivePoolState(wsolMint);
  const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
  
  if (poolAccount && poolAccount.data.length >= 72) {
    const data = Buffer.from(poolAccount.data);
    // PoolState layout: discriminator[8] + authority[32] + origin_mint[32] + ...
    const originMint = new PublicKey(data.slice(40, 72));
    console.log(`Pool exists at ${poolState.toBase58()}`);
    console.log(`  Origin mint in pool: ${originMint.toBase58()}`);
    console.log(`  Expected (wSOL): ${wsolMint.toBase58()}`);
    console.log(`  Match: ${originMint.equals(wsolMint)}`);
    
    if (!originMint.equals(wsolMint)) {
      console.log(`\n❌ MISMATCH: Pool was initialized with ${originMint.toBase58()}, not wSOL!`);
      console.log(`   This explains the OriginMintMismatch error.`);
      console.log(`   Solution: Need to either use the correct mint or re-initialize the pool.`);
    }
  } else {
    console.log('Pool does not exist or is too small');
  }
}

check().catch(console.error);
