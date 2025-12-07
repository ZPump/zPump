import { Connection, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { deriveMintMapping } from '../lib/onchain/pdas';
import { BorshCoder } from '@coral-xyz/anchor';
import factoryIdl from '../idl/ptf_factory.json';

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
const factoryCoder = new BorshCoder(factoryIdl as any);

async function decode() {
  const nativeMint = NATIVE_MINT;
  const mintMapping = deriveMintMapping(nativeMint);
  
  const account = await connection.getAccountInfo(mintMapping, 'confirmed');
  
  if (!account) {
    console.log('❌ Account does not exist');
    return;
  }
  
  console.log('✅ Account exists');
  console.log('Owner:', account.owner.toBase58());
  console.log('Data length:', account.data.length);
  
  try {
    const decoded = factoryCoder.accounts.decode('MintMapping', account.data) as any;
    console.log('✅ Decoded successfully!');
    console.log('Origin mint:', new PublicKey(decoded.originMint || decoded.origin_mint).toBase58());
    console.log('Decimals:', decoded.decimals);
    console.log('Status:', decoded.status);
    console.log('Has PTKN:', decoded.hasPtkn || decoded.has_ptkn);
  } catch (error) {
    console.log('❌ Failed to decode:', (error as Error).message);
  }
}

decode().catch(console.error);

