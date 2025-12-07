import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { resolveKeypairPath } from '../lib/wallet/localWallet';
import { readFileSync } from 'fs';

async function test() {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const keypairPath = resolveKeypairPath();
  const keypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(keypairPath, 'utf-8')))
  );
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, {});
  
  console.log('Testing payer signer issue...');
  console.log(`Payer: ${wallet.publicKey.toBase58()}`);
  
  // Create a simple test instruction that requires payer as signer
  const testIx = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.alloc(0)
  });
  
  const tx = new Transaction().add(testIx);
  tx.feePayer = wallet.publicKey;
  
  // Check if transaction is properly signed
  console.log('\nTransaction details:');
  console.log(`  Fee payer: ${tx.feePayer?.toBase58()}`);
  console.log(`  Signatures: ${tx.signatures.length}`);
  tx.signatures.forEach((sig, i) => {
    console.log(`    [${i}] ${sig.publicKey.toBase58()}: ${sig.signature ? 'SIGNED' : 'NOT SIGNED'}`);
  });
  
  // Try to send and see what happens
  try {
    const sig = await connection.sendTransaction(tx, [keypair], { skipPreflight: false });
    console.log(`\n✅ Transaction sent: ${sig}`);
  } catch (error: any) {
    console.error(`\n❌ Error: ${error.message}`);
  }
}

test().catch(console.error);
