import { Connection, PublicKey } from '@solana/web3.js';
import { deriveMintMapping } from '../lib/onchain/pdas';

async function debug() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  
  // Check what mint would produce the expected mapping
  const expectedMapping = new PublicKey('7o75rbYMU7mMqpkBuJ8RKj6i8dVjshQpVBLRjZcknaud');
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  
  console.log('Expected mapping (from error):', expectedMapping.toBase58());
  console.log('wSOL mapping (what we pass):', deriveMintMapping(wsolMint).toBase58());
  
  // Check if expected mapping exists on-chain
  const expectedMappingInfo = await connection.getAccountInfo(expectedMapping, 'confirmed');
  console.log('\nExpected mapping account exists:', !!expectedMappingInfo);
  
  if (expectedMappingInfo) {
    console.log('  Owner:', expectedMappingInfo.owner.toBase58());
    console.log('  Data length:', expectedMappingInfo.data.length);
    
    // Try to decode the origin_mint from the mapping
    if (expectedMappingInfo.data.length >= 40) {
      const data = Buffer.from(expectedMappingInfo.data);
      const originMint = new PublicKey(data.slice(8, 40)); // Skip discriminator
      console.log('  Origin mint in mapping:', originMint.toBase58());
      console.log('  Matches wSOL:', originMint.equals(wsolMint));
    }
  } else {
    console.log('\n❌ Expected mapping does NOT exist on-chain!');
    console.log('   This means the program is trying to derive a mapping for a mint');
    console.log('   that doesn\'t have a mapping registered.');
    console.log('   The program must be reading a different origin_mint than we pass.');
  }
}

debug().catch(console.error);
