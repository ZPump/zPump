#!/usr/bin/env node
/* eslint-disable no-console */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
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

async function initFactory() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = await loadKeypair(`${process.env.HOME || '~'}/.config/solana/id.json`);
  
  console.log('Initializing factory...');
  
  // Derive factory state PDA
  const [factoryState] = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), FACTORY_PROGRAM_ID.toBuffer()],
    FACTORY_PROGRAM_ID
  );
  
  console.log(`Factory state: ${factoryState.toBase58()}`);
  
  // Check if factory state already exists
  const factoryStateInfo = await connection.getAccountInfo(factoryState);
  if (factoryStateInfo) {
    console.log('✓ Factory already initialized');
    return;
  }
  
  // Build initialize_factory instruction manually
  // Discriminator: [179, 64, 75, 250, 39, 254, 240, 178]
  const initDiscriminator = Buffer.from([179, 64, 75, 250, 39, 254, 240, 178]);
  
  // Args: authority (Pubkey), default_fee_bps (u16), timelock_seconds (u64)
  const argsBuffer = Buffer.alloc(32 + 2 + 8); // Pubkey (32) + u16 (2) + u64 (8)
  let offset = 0;
  
  // authority: Pubkey (32 bytes)
  payer.publicKey.toBuffer().copy(argsBuffer, offset);
  offset += 32;
  
  // default_fee_bps: u16 (5 = 0x0005)
  argsBuffer.writeUInt16LE(5, offset);
  offset += 2;
  
  // timelock_seconds: u64 (0)
  argsBuffer.writeBigUInt64LE(BigInt(0), offset);
  
  // Combine discriminator + args
  const instructionData = Buffer.concat([initDiscriminator, argsBuffer]);
  
  // Build account metas: factory_state, payer, system_program
  const initIx = new TransactionInstruction({
    programId: FACTORY_PROGRAM_ID,
    keys: [
      { pubkey: factoryState, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: instructionData
  });
  
  const tx = new Transaction().add(initIx);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`✓ Factory initialized: ${sig}`);
}

initFactory().catch(console.error);

