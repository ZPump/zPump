import { Connection, PublicKey } from '@solana/web3.js';
import { derivePoolState, deriveMintMapping } from '../lib/onchain/pdas';
import poolIdl from '../idl/ptf_pool.json';
import { BorshCoder, Idl } from '@coral-xyz/anchor';

async function test() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
  
  const poolCoder = new BorshCoder(poolIdl as Idl);
  const ixDef = (poolIdl as Idl).instructions?.find((item) => item.name === 'initialize_pool');
  
  if (!ixDef) {
    console.error('initialize_pool not found in IDL');
    return;
  }
  
  console.log('initialize_pool account order:');
  ixDef.accounts?.forEach((acc, i) => {
    console.log(`  ${i}: ${acc.name}`);
  });
  
  // Check what we're passing
  const poolState = derivePoolState(wsolMint);
  const mintMapping = deriveMintMapping(wsolMint);
  
  console.log(`\nWe're passing:`);
  console.log(`  origin_mint: ${wsolMint.toBase58()}`);
  console.log(`  mint_mapping: ${mintMapping.toBase58()}`);
  console.log(`  pool_state: ${poolState.toBase58()}`);
  
  // Check if origin_mint account exists
  const originMintInfo = await connection.getAccountInfo(wsolMint, 'confirmed');
  console.log(`\norigin_mint account exists: ${!!originMintInfo}`);
  if (originMintInfo) {
    console.log(`  Owner: ${originMintInfo.owner.toBase58()}`);
    console.log(`  Is SPL token mint: ${originMintInfo.owner.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}`);
  }
}

test().catch(console.error);
