import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { resolveKeypairPath } from '../lib/wallet/localWallet';

async function test() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const keypairPath = resolveKeypairPath();
  const keypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(keypairPath, 'utf-8')))
  );
  
  console.log('Testing signature behavior...');
  console.log(`Keypair: ${keypair.publicKey.toBase58()}`);
  
  // Create a transaction with the same account as both authority and payer
  const testIx = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },  // authority (position 0)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },  // payer (position 2)
    ],
    data: Buffer.alloc(0)
  });
  
  const tx = new Transaction().add(testIx);
  tx.feePayer = keypair.publicKey;
  
  // Sign with transaction.sign()
  tx.sign(keypair);
  
  console.log(`\nTransaction signatures: ${tx.signatures.length}`);
  tx.signatures.forEach((sig, i) => {
    console.log(`  [${i}] ${sig.publicKey.toBase58()}: ${sig.signature ? 'SIGNED' : 'NOT SIGNED'}`);
  });
  
  // Check instruction keys
  console.log('\nInstruction keys:');
  testIx.keys.forEach((key, i) => {
    console.log(`  [${i}] ${key.pubkey.toBase58()} (signer=${key.isSigner}, writable=${key.isWritable})`);
  });
  
  // Verify: if same account appears multiple times as signer, does it need multiple signatures?
  const signerKeys = testIx.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58());
  const uniqueSigners = new Set(signerKeys);
  console.log(`\nUnique signer accounts: ${uniqueSigners.size}`);
  console.log(`Total signer positions: ${signerKeys.length}`);
  console.log(`Signatures in transaction: ${tx.signatures.length}`);
  console.log(`Match: ${uniqueSigners.size === tx.signatures.length ? 'YES' : 'NO'}`);
}

test().catch(console.error);
