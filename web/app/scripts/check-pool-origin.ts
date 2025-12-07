import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState } from '../lib/onchain/pdas';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
const nativeSolMint = new PublicKey('11111111111111111111111111111112');
const poolState = derivePoolState(wsolMint);

connection.getAccountInfo(poolState, 'confirmed').then(account => {
  if (account && account.data.length >= 72) {
    const data = Buffer.from(account.data);
    // PoolState layout: discriminator[8] + authority[32] + origin_mint[32] + ...
    const originMint = new PublicKey(data.slice(40, 72));
    console.log(`\nPool state: ${poolState.toBase58()}`);
    console.log(`Origin mint in pool: ${originMint.toBase58()}`);
    console.log(`Expected (wSOL): ${wsolMint.toBase58()}`);
    console.log(`Native SOL: ${nativeSolMint.toBase58()}`);
    console.log(`\nMatch wSOL: ${originMint.equals(wsolMint)}`);
    console.log(`Match native SOL: ${originMint.equals(nativeSolMint)}`);
    
    if (!originMint.equals(wsolMint)) {
      console.log(`\n❌ POOL MISMATCH: Pool was initialized with ${originMint.toBase58()}, but we need ${wsolMint.toBase58()}`);
      console.log(`   This will cause OriginMintMismatch errors.`);
      console.log(`   Solution: The pool needs to be re-initialized for wSOL.`);
    } else {
      console.log(`\n✅ Pool is correctly initialized for wSOL`);
    }
  } else {
    console.log('Pool state does not exist or is too small');
  }
}).catch(console.error);
