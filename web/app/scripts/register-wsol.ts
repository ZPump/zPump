#!/usr/bin/env node
/* eslint-disable no-console */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { FACTORY_PROGRAM_ID } from '../lib/onchain/programIds';
import * as fs from 'fs/promises';
import * as path from 'path';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';

async function loadKeypair(filePath: string): Promise<Keypair> {
  const absolute = path.resolve(filePath.replace('~', process.env.HOME || ''));
  const raw = await fs.readFile(absolute, 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

async function registerWSOL() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = await loadKeypair(`${process.env.HOME || '~'}/.config/solana/id.json`);
  
  console.log('Registering wSOL (native SOL mint)...');
  
  // Derive factory state and mint mapping PDAs
  const [factoryState] = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), FACTORY_PROGRAM_ID.toBuffer()],
    FACTORY_PROGRAM_ID
  );
  
  const [mintMapping] = PublicKey.findProgramAddressSync(
    [Buffer.from('map'), NATIVE_MINT.toBuffer()],
    FACTORY_PROGRAM_ID
  );
  
  console.log(`Factory state: ${factoryState.toBase58()}`);
  console.log(`Mint mapping: ${mintMapping.toBase58()}`);
  
  // Check if factory state exists
  const factoryStateInfo = await connection.getAccountInfo(factoryState);
  if (!factoryStateInfo) {
    console.log('Factory state does not exist. Please run bootstrap script first.');
    console.log('Factory must be initialized before registering mints.');
    return;
  } else {
    console.log('✓ Factory already initialized');
  }
  
  // Check if wSOL is already registered
  const mintMappingInfo = await connection.getAccountInfo(mintMapping);
  if (mintMappingInfo && mintMappingInfo.owner.equals(FACTORY_PROGRAM_ID)) {
    console.log('✓ wSOL already registered');
    return;
  }
  
  // Register wSOL using manual instruction (like test script)
  console.log('Registering wSOL mint mapping...');
  
  // Build instruction manually (like bootstrap script does for wSOL)
  const registerMintDiscriminator = Buffer.from([242, 43, 74, 162, 217, 214, 191, 171]);
  
  // Build instruction args: u8 (decimals), bool (enable_ptkn), Option<u8> (feature_flags), Option<u16> (fee_bps_override)
  const argsBuffer = Buffer.alloc(1 + 1 + 1 + 2); // u8 + bool + Option<u8> + Option<u16>
  let offset = 0;
  
  // decimals: u8 (9 for wSOL)
  argsBuffer.writeUInt8(9, offset);
  offset += 1;
  
  // enable_ptkn: bool (false = 0)
  argsBuffer.writeUInt8(0, offset);
  offset += 1;
  
  // feature_flags: Option<u8> (None = 0)
  argsBuffer.writeUInt8(0, offset);
  offset += 1;
  
  // fee_bps_override: Option<u16> (None = 0)
  argsBuffer.writeUInt16LE(0, offset);
  
  // Combine discriminator + args
  const instructionData = Buffer.concat([registerMintDiscriminator, argsBuffer]);
  
  // Build account metas manually in the exact order from IDL
  // From test script: factoryState, payer (signer, non-writable), mintMapping, mint, payer (signer, writable), ...
  const registerIx = {
    programId: FACTORY_PROGRAM_ID,
    keys: [
      { pubkey: factoryState, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: mintMapping, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true }, // ptkn_mint (optional placeholder - use payer as writable placeholder)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // token_program (optional)
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent sysvar
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } // system_program
    ],
    data: instructionData
  };
  
  const registerTx = new Transaction().add(registerIx);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  registerTx.recentBlockhash = latestBlockhash.blockhash;
  registerTx.feePayer = payer.publicKey;
  registerTx.sign(payer);
  
  const registerSig = await connection.sendRawTransaction(registerTx.serialize());
  await connection.confirmTransaction(registerSig, 'confirmed');
  console.log(`✓ wSOL registered: ${registerSig}`);
}

registerWSOL().catch(console.error);

