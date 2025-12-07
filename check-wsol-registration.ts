import { Connection, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';

const FACTORY_ID = new PublicKey('94XEJsvLbTNYit4mXowjhqkDpwqtnXnKs2KtF3PNW2oK');
const [mintMapping] = PublicKey.findProgramAddressSync(
  [Buffer.from('map'), NATIVE_MINT.toBuffer()],
  FACTORY_ID
);

const conn = new Connection('http://127.0.0.1:8899', 'confirmed');

async function check() {
  console.log('wSOL mint mapping address:', mintMapping.toBase58());
  const account = await conn.getAccountInfo(mintMapping, 'confirmed');
  console.log('Account exists:', account !== null);
  if (account) {
    console.log('Owner:', account.owner.toBase58());
    console.log('Data length:', account.data.length);
    console.log('Expected owner (factory):', FACTORY_ID.toBase58());
    console.log('Owner matches:', account.owner.equals(FACTORY_ID));
  } else {
    console.log('❌ wSOL mint mapping does not exist on-chain!');
    console.log('Need to register it via bootstrap script.');
  }
}

check().catch(console.error);

