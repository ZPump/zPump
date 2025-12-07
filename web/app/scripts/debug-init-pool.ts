import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState, deriveMintMapping } from '../lib/onchain/pdas';

async function debug() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  const nativeSolMint = new PublicKey('11111111111111111111111111111112');
  
  console.log('wSOL mint:', wsolMint.toBase58());
  console.log('Native SOL mint:', nativeSolMint.toBase58());
  
  const wsolMapping = deriveMintMapping(wsolMint);
  const nativeMapping = deriveMintMapping(nativeSolMint);
  
  console.log('\nwSOL mapping:', wsolMapping.toBase58());
  console.log('Native SOL mapping:', nativeMapping.toBase58());
  console.log('Expected (from error): 7o75rbYMU7mMqpkBuJ8RKj6i8dVjshQpVBLRjZcknaud');
  
  // Check what mint the expected mapping corresponds to
  // The mapping is: find_program_address([b"map", origin_mint.as_ref()], factory_id)
  // We can't reverse it, but we can check if there's a mint mapping account at that address
  const expectedMapping = new PublicKey('7o75rbYMU7mMqpkBuJ8RKj6i8dVjshQpVBLRjZcknaud');
  const expectedInfo = await connection.getAccountInfo(expectedMapping, 'confirmed');
  
  if (expectedInfo) {
    console.log('\nExpected mapping account exists!');
    console.log('Owner:', expectedInfo.owner.toBase58());
    console.log('Data length:', expectedInfo.data.length);
    
    // Try to decode the origin_mint from the mapping
    if (expectedInfo.data.length >= 40) {
      const data = Buffer.from(expectedInfo.data);
      const originMint = new PublicKey(data.slice(8, 40)); // Skip discriminator
      console.log('Origin mint in expected mapping:', originMint.toBase58());
      console.log('Matches wSOL:', originMint.equals(wsolMint));
      console.log('Matches native SOL:', originMint.equals(nativeSolMint));
    }
  } else {
    console.log('\nExpected mapping account does NOT exist');
  }
}

debug().catch(console.error);
