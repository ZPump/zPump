/**
 * Test shield_execute in isolation (single instruction transaction)
 * 
 * This test checks if the multi-instruction transaction context is causing
 * the access violation in shield_execute.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY
} from '@solana/web3.js';
import {
  prepareShield,
  executeShield,
  preparePool
} from '../lib/sdk';
import { createWalletAdapter } from './utils/walletAdapter';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { BorshCoder } from '@coral-xyz/anchor';
import { POOL_PROGRAM_ID } from '../lib/onchain/programIds';
import poolIdl from '../idl/ptf_pool.json';
import * as pdas from '../lib/onchain/pdas';
import { VERIFIER_PROGRAM_ID, VAULT_PROGRAM_ID, FACTORY_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../lib/onchain/programIds';
import { getAssociatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { ProofClient } from '../lib/proofClient';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';

async function airdropSol(connection: Connection, address: PublicKey, amount: bigint): Promise<void> {
  const signature = await connection.requestAirdrop(address, Number(amount));
  await connection.confirmTransaction(signature, 'confirmed');
}

function deriveProofVault(owner: PublicKey): PublicKey {
  const [proofVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('proof-vault'), owner.toBuffer()],
    POOL_PROGRAM_ID
  );
  return proofVault;
}

function operationIdHexToArray(hex: string): number[] {
  const bytes = Buffer.from(hex, 'hex');
  return Array.from(bytes);
}

async function testShieldIsolated() {
  console.log('\n=== Test: Shield Execute in Isolation (Single Instruction) ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  try {
    // Use wSOL which is already registered
    const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
    const testMint = new PublicKey(originMint);
    console.log(`   ✓ Using mint: ${originMint}`);
    
    // Initialize pool if needed
    console.log('1. Checking and initializing pool if needed...');
    const poolState = pdas.derivePoolState(testMint);
    const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
    if (poolAccount && poolAccount.data.length >= 8 + 32) {
      console.log('   ✓ Pool is already initialized');
    } else {
      console.log('   ℹ️  Pool not initialized - initializing via preparePool...');
      const poolResult = await preparePool({
        connection,
        wallet,
        originMint,
        keypair
      });
      if (poolResult.poolInitialized) {
        console.log('   ✓ Pool initialized successfully');
      }
    }
    
    // Prepare shield operation
    console.log('2. Preparing shield operation...');
    const amount = BigInt(100_000_000);
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const currentRoot = await fetchZTokenPoolRoot(connection, testMint);
    const depositId = Date.now().toString();
    const blinding = Math.floor(Math.random() * 10 ** 18).toString();
    
    const proof = await proofClient.requestProof('wrap', {
      oldRoot: currentRoot,
      amount: amount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId,
      poolId: poolState.toBase58(),
      blinding,
      mintId: originMint
    });
    console.log('   ✓ Proof generated');
    
    const { operationId, signature: prepareSig } = await prepareShield({
      wallet,
      connection,
      originMint,
      amount,
      depositId,
      blinding,
      proof,
      proofClient
    });
    console.log(`   ✓ Prepare signature: ${prepareSig}`);
    console.log(`   ✓ Operation ID: ${operationId}`);
    
    // Derive all accounts needed for shield_execute
    console.log('3. Deriving accounts for shield_execute...');
    const commitmentTreeKey = pdas.deriveCommitmentTree(testMint);
    const nullifierSet = pdas.deriveNullifierSet(testMint);
    const noteLedger = pdas.deriveNoteLedger(testMint);
    const hookConfig = pdas.deriveHookConfig(testMint);
    const hookWhitelist = pdas.deriveHookWhitelist(testMint);
    const vaultState = pdas.deriveVaultState(testMint);
    const proofVault = deriveProofVault(keypair.publicKey);
    const verifyingKey = pdas.deriveVerifyingKey();
    const shieldClaim = pdas.deriveShieldClaim(poolState);
    const mintMappingKey = pdas.deriveMintMapping(testMint, FACTORY_PROGRAM_ID);
    const factoryState = pdas.deriveFactoryState();
    
    const vaultTokenAccount = await getAssociatedTokenAddress(
      testMint,
      vaultState,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    const depositorTokenAccount = await getAssociatedTokenAddress(
      testMint,
      keypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    // Ensure vault token account exists
    const vaultTokenAccountInfo = await connection.getAccountInfo(vaultTokenAccount, 'confirmed');
    if (!vaultTokenAccountInfo) {
      console.log('   Creating vault token account...');
      const createVaultTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey,
          vaultTokenAccount,
          vaultState,
          testMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      createVaultTx.feePayer = keypair.publicKey;
      const createVaultBlockhash = await connection.getLatestBlockhash('confirmed');
      createVaultTx.recentBlockhash = createVaultBlockhash.blockhash;
      createVaultTx.sign(keypair);
      const createVaultSig = await connection.sendRawTransaction(createVaultTx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(createVaultSig, 'confirmed');
      console.log(`   ✓ Vault token account created: ${createVaultSig}`);
    } else {
      console.log('   ✓ Vault token account already exists');
    }
    
    // Build shield_execute instruction in isolation (NO finalize instructions)
    console.log('4. Building shield_execute instruction (ISOLATED - single instruction)...');
    const poolCoder = new BorshCoder(poolIdl as any);
    // TESTING: Using execute_shield_v2 to test if instruction name causes access violation
    const shieldData = poolCoder.instruction.encode('execute_shield_v2', {
      operation_id: operationIdHexToArray(operationId)
    });
    
    const shieldKeys = [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // _phantom
    ];
    
    const remainingAccounts = [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true }, // payer (FIRST)
      { pubkey: proofVault, isSigner: false, isWritable: true }, // proof_vault (SECOND)
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent (THIRD)
      { pubkey: poolState, isSigner: false, isWritable: true }, // pool_state
      { pubkey: commitmentTreeKey, isSigner: false, isWritable: true }, // commitment_tree
      { pubkey: testMint, isSigner: false, isWritable: false }, // origin_mint
      { pubkey: hookConfig, isSigner: false, isWritable: false },
      { pubkey: hookWhitelist, isSigner: false, isWritable: true },
      { pubkey: nullifierSet, isSigner: false, isWritable: true },
      { pubkey: noteLedger, isSigner: false, isWritable: true },
      { pubkey: vaultState, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: verifyingKey, isSigner: false, isWritable: false },
      { pubkey: shieldClaim, isSigner: false, isWritable: true },
      { pubkey: mintMappingKey, isSigner: false, isWritable: false },
      { pubkey: factoryState, isSigner: false, isWritable: false },
      { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];
    
    const allShieldKeys = [...shieldKeys, ...remainingAccounts];
    const shieldInstruction = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: allShieldKeys,
      data: shieldData
    });
    
    // Create transaction with ONLY shield_execute instruction (no finalize instructions)
    console.log('5. Sending isolated shield_execute transaction...');
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction().add(shieldInstruction); // ONLY shield_execute, no other instructions
    tx.feePayer = keypair.publicKey;
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.sign(keypair);
    
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    console.log(`   ✓ Transaction sent: ${signature}`);
    
    await connection.confirmTransaction(signature, 'confirmed');
    console.log('   ✓ Shield executed successfully in isolation!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Transaction logs:');
      error.logs.forEach((log: string) => console.error(`     ${log}`));
    }
    return false;
  }
}

// Run test
testShieldIsolated()
  .then(success => {
    if (success) {
      console.log('\n✅ Isolated shield_execute test PASSED');
      process.exit(0);
    } else {
      console.log('\n❌ Isolated shield_execute test FAILED');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

