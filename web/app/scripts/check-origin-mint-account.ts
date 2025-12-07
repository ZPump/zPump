import { Connection, PublicKey } from '@solana/web3.js';

async function check() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  const nativeSolMint = new PublicKey('11111111111111111111111111111112');
  
  console.log('Checking mint accounts...\n');
  
  const [wsolInfo, nativeInfo] = await Promise.all([
    connection.getAccountInfo(wsolMint, 'confirmed'),
    connection.getAccountInfo(nativeSolMint, 'confirmed')
  ]);
  
  console.log(`wSOL mint (${wsolMint.toBase58()}):`);
  console.log(`  Exists: ${!!wsolInfo}`);
  if (wsolInfo) {
    console.log(`  Owner: ${wsolInfo.owner.toBase58()}`);
    console.log(`  Data length: ${wsolInfo.data.length}`);
  }
  
  console.log(`\nNative SOL mint (${nativeSolMint.toBase58()}):`);
  console.log(`  Exists: ${!!nativeInfo}`);
  if (nativeInfo) {
    console.log(`  Owner: ${nativeInfo.owner.toBase58()}`);
    console.log(`  Data length: ${nativeInfo.data.length}`);
  }
  
  // The native SOL "mint" is actually the system program
  // wSOL is the actual SPL token mint
  console.log('\nNote: Native SOL "mint" is actually the system program.');
  console.log('wSOL is the actual SPL token mint for wrapped SOL.');
  console.log('\nWhen shielding SOL, we should use wSOL mint account, not native SOL.');
}

check().catch(console.error);
