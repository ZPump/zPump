import { Connection, PublicKey } from '@solana/web3.js';
import { deriveMintMapping } from '../lib/onchain/pdas';

async function check() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  const nativeSolMint = new PublicKey('11111111111111111111111111111112');

  const wsolMapping = deriveMintMapping(wsolMint);
  const nativeMapping = deriveMintMapping(nativeSolMint);

  console.log(`wSOL mint: ${wsolMint.toBase58()}`);
  console.log(`wSOL mapping: ${wsolMapping.toBase58()}`);
  console.log(`\nNative SOL mint: ${nativeSolMint.toBase58()}`);
  console.log(`Native SOL mapping: ${nativeMapping.toBase58()}`);

  const [wsolInfo, nativeInfo] = await Promise.all([
    connection.getAccountInfo(wsolMapping, 'confirmed'),
    connection.getAccountInfo(nativeMapping, 'confirmed')
  ]);

  console.log(`\nwSOL mapping exists: ${!!wsolInfo}`);
  console.log(`Native SOL mapping exists: ${!!nativeInfo}`);

  if (wsolInfo) {
    console.log(`wSOL mapping owner: ${wsolInfo.owner.toBase58()}`);
    console.log(`wSOL mapping data length: ${wsolInfo.data.length}`);
  }

  if (nativeInfo) {
    console.log(`Native SOL mapping owner: ${nativeInfo.owner.toBase58()}`);
    console.log(`Native SOL mapping data length: ${nativeInfo.data.length}`);
  }
}

check().catch(console.error);
