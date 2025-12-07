import { Connection, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { deriveMintMapping } from '../lib/onchain/pdas';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');

async function verify() {
  const nativeMint = NATIVE_MINT;
  const mintMapping = deriveMintMapping(nativeMint);
  
  console.log('Native SOL mint:', nativeMint.toBase58());
  console.log('wSOL mint mapping address:', mintMapping.toBase58());
  
  const account = await connection.getAccountInfo(mintMapping, 'confirmed');
  
  if (account) {
    console.log('✅ Account exists!');
    console.log('Owner:', account.owner.toBase58());
    console.log('Data length:', account.data.length);
    console.log('Lamports:', account.lamports);
  } else {
    console.log('❌ Account does NOT exist!');
    console.log('Need to register wSOL via bootstrap script.');
  }
}

verify().catch(console.error);

