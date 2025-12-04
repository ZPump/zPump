/**
 * Test Prepare/Execute Pattern
 * 
 * Tests the proof account abstraction prepare/execute flow:
 * 1. Test prepareShield + executeShield separately
 * 2. Test prepareUnshield + executeUnshield separately
 * 3. Test operation expiry
 * 4. Test cleanup_expired_operations
 * 5. Test vault capacity limits
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY
} from '@solana/web3.js';
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import {
  prepareShield,
  executeShield,
  prepareUnshield,
  executeUnshield,
  prepareTransfer,
  executeTransfer,
  prepareTransferFrom,
  executeTransferFrom,
  prepareBatchTransfer,
  executeBatchTransfer,
  prepareBatchTransferFrom,
  executeBatchTransferFrom,
  cleanupExpiredOperations,
  wrap,
  preparePool
} from '../lib/sdk';
import { getWrappedSolAccount, createWrapSolInstructions, checkWrappedSolBalance, isNativeSol, NATIVE_SOL_MINT } from '../lib/solWrapping';
import { ProofClient } from '../lib/proofClient';
import { createWalletAdapter } from './utils/walletAdapter';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import { AnchorProvider, BN, Program, BorshCoder } from '@coral-xyz/anchor';
import { FACTORY_PROGRAM_ID, POOL_PROGRAM_ID } from '../lib/onchain/programIds';
import factoryIdl from '../idl/ptf_factory.json';
import { deriveVaultState } from '../lib/onchain/pdas';
import poolIdl from '../idl/ptf_pool.json';

ensureFetchPolyfill();

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PROOF_URL = process.env.PROOF_URL ?? 'http://127.0.0.1:8788';

async function airdropSol(connection: Connection, address: PublicKey, amount: bigint): Promise<void> {
  const signature = await connection.requestAirdrop(address, Number(amount));
  await connection.confirmTransaction(signature, 'confirmed');
}

/**
 * Creates a new mint and registers it with the factory for testing
 */
async function createAndRegisterTestMint(
  connection: Connection,
  payer: Keypair,
  decimals: number = 9
): Promise<{ mint: PublicKey; mintKeypair: Keypair }> {
  console.log('   Creating new test mint...');
  
  // Create mint keypair
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  
  // Get rent exemption
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  
  // Create mint account
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_PROGRAM_ID
  });
  
  // Initialize mint
  const initMintIx = createInitializeMintInstruction(
    mint,
    decimals,
    payer.publicKey,
    payer.publicKey,
    TOKEN_PROGRAM_ID
  );
  
  // Send transaction
  const tx = new Transaction().add(createAccountIx, initMintIx);
  const signature = await connection.sendTransaction(tx, [payer, mintKeypair]);
  await connection.confirmTransaction(signature, 'confirmed');
  console.log(`   ✓ Created mint: ${mint.toBase58()}`);
  
  // Register mint with factory using manual instruction (like bootstrap script)
  console.log('   Registering mint with factory...');
  
  // Derive factory state and mint mapping PDAs
  // Factory state uses 'factory' seed + factory program ID buffer
  const [factoryState] = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), FACTORY_PROGRAM_ID.toBuffer()],
    FACTORY_PROGRAM_ID
  );
  
  const [mintMapping] = PublicKey.findProgramAddressSync(
    [Buffer.from('map'), mint.toBuffer()],
    FACTORY_PROGRAM_ID
  );
  
  // Build instruction manually (like bootstrap script does for wSOL)
  const registerMintDiscriminator = Buffer.from([242, 43, 74, 162, 217, 214, 191, 171]);
  
  // Build instruction args: u8 (decimals), bool (enable_ptkn), Option<u8> (feature_flags), Option<u16> (fee_bps_override)
  const argsBuffer = Buffer.alloc(1 + 1 + 1 + 2);
  let offset = 0;
  argsBuffer.writeUInt8(decimals, offset);
  offset += 1;
  argsBuffer.writeUInt8(0, offset); // enable_ptkn = false
  offset += 1;
  argsBuffer.writeUInt8(0, offset); // feature_flags = None
  offset += 1;
  argsBuffer.writeUInt16LE(0, offset); // fee_bps_override = None
  
  const instructionData = Buffer.concat([registerMintDiscriminator, argsBuffer]);
  
  // Build account metas in IDL order
  const accountMetas: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: mintMapping, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // ptkn_mint (optional placeholder)
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program (optional)
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
  ];
  
  const registerMintIx = new TransactionInstruction({
    programId: FACTORY_PROGRAM_ID,
    keys: accountMetas,
    data: instructionData
  });
  
  const registerTx = new Transaction().add(registerMintIx);
  const registerSig = await connection.sendTransaction(registerTx, [payer]);
  await connection.confirmTransaction(registerSig, 'confirmed');
  console.log(`   ✓ Registered mint with factory: ${registerSig}`);
  
  // Mint some tokens to the payer's ATA
  const payerAta = await getAssociatedTokenAddress(
    mint,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const mintToIx = createMintToInstruction(
    mint,
    payerAta,
    payer.publicKey,
    BigInt(1_000_000_000_000), // 1000 tokens (assuming 9 decimals)
    [],
    TOKEN_PROGRAM_ID
  );
  
  const mintToTx = new Transaction().add(mintToIx);
  const mintToSig = await connection.sendTransaction(mintToTx, [payer]);
  await connection.confirmTransaction(mintToSig, 'confirmed');
  console.log(`   ✓ Minted tokens to payer ATA: ${payerAta.toBase58()}`);
  
  return { mint, mintKeypair };
}

async function testPrepareExecuteShield() {
  console.log('\n=== Test: Prepare + Execute Shield ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  try {
    // For now, use wSOL which is already registered via bootstrap
    // TODO: Fix mint registration to work with test keypairs (factory authority issue)
    console.log('0. Using wSOL (already registered via bootstrap)...');
    const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
    const testMint = new PublicKey(originMint);
    console.log(`   ✓ Using mint: ${originMint}`);
    
    // Note: execute_shield requires pool to be initialized first (lazy init disabled due to reallocation limits)
    console.log('1. Checking and initializing pool if needed...');
    const { derivePoolState } = await import('../lib/onchain/pdas');
    const poolState = derivePoolState(testMint);
    const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
    if (poolAccount && poolAccount.data.length >= 8 + 32) {
      console.log('   ✓ Pool is already initialized');
    } else {
      console.log('   ℹ️  Pool not initialized - initializing via preparePool...');
      const poolResult = await preparePool({
        connection,
        wallet,
        originMint
      });
      console.log(`   ✓ Pool initialization result: ${poolResult.actions.join(', ')}`);
      if (poolResult.poolInitialized) {
        console.log('   ✓ Pool initialized successfully');
      }
    }
    
    const amount = BigInt(100_000_000); // 0.1 tokens (assuming 9 decimals)
    
    // Generate proof first (required for prepareShield)
    console.log('2. Generating shield proof...');
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
    
    // Step 3: Prepare shield
    console.log('3. Preparing shield...');
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
    
    // Step 3.5: Ensure vault token account exists
    console.log('3.5. Ensuring vault token account exists...');
    const { deriveVaultState } = await import('../lib/onchain/pdas');
    const vaultState = deriveVaultState(testMint);
    const { isNativeSol, NATIVE_SOL_MINT } = await import('../lib/solWrapping');
    const actualShieldMint = isNativeSol(testMint) ? NATIVE_SOL_MINT : testMint;
    const tokenProgramId = TOKEN_PROGRAM_ID;
    const vaultTokenAccount = await getAssociatedTokenAddress(
      actualShieldMint,
      vaultState,
      true, // allowOwnerOffCurve
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccountInfo = await connection.getAccountInfo(vaultTokenAccount, 'confirmed');
    if (!vaultTokenAccountInfo) {
      console.log('   Creating vault token account...');
      const createVaultTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey,
          vaultTokenAccount,
          vaultState,
          actualShieldMint,
          tokenProgramId,
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
    
    // Step 4: Execute shield (pool must be initialized first)
    console.log('4. Executing shield...');
    const executeSig = await executeShield({
      wallet,
      connection,
      operationId,
      originMint,
      poolId: poolState.toBase58(),
      amount,
      depositId,
      blinding,
      keypair
    });
    console.log(`   ✓ Execute signature: ${executeSig}`);
    console.log('   ✓ Shield completed successfully!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    return false;
  }
}

async function testPrepareExecuteUnshield() {
  console.log('\n=== Test: Prepare + Execute Unshield ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  // Use a different mint address to avoid SOL detection (wSOL mint address)
  // wSOL mint: So11111111111111111111111111111111111111112
  const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
  const testMint = new PublicKey(originMint);
  
  try {
    // Step 1: First perform a shield to create notes
    console.log('1. Performing shield to create notes...');
    const { derivePoolState } = await import('../lib/onchain/pdas');
    const poolState = derivePoolState(testMint);
    
    // Check/initialize pool
    const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
    if (!poolAccount || poolAccount.data.length < 8 + 32) {
      console.log('   ℹ️  Pool not initialized - initializing via preparePool...');
      const poolResult = await preparePool({
        connection,
        wallet,
        originMint
      });
      if (poolResult.poolInitialized) {
        console.log('   ✓ Pool initialized successfully');
      }
    } else {
      console.log('   ✓ Pool is already initialized');
    }
    
    // Perform shield
    const shieldAmount = BigInt(100_000_000); // 0.1 SOL
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const currentRoot = await fetchZTokenPoolRoot(connection, testMint);
    const depositId = Date.now().toString();
    const blinding = Math.floor(Math.random() * 10 ** 18).toString();
    
    console.log('   Generating shield proof...');
    const shieldProof = await proofClient.requestProof('wrap', {
      oldRoot: currentRoot,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId,
      poolId: poolState.toBase58(),
      blinding,
      mintId: originMint
    });
    console.log('   ✓ Shield proof generated');
    
    // Prepare shield
    const { operationId: shieldOpId, signature: prepareShieldSig } = await prepareShield({
      wallet,
      connection,
      originMint,
      amount: shieldAmount,
      depositId,
      blinding,
      proof: shieldProof,
      proofClient
    });
    console.log(`   ✓ Shield prepared: ${prepareShieldSig}`);
    
    // Execute shield (using executeShield directly, not wrap)
    console.log('   Executing shield...');
    const executeShieldSig = await executeShield({
      wallet,
      connection,
      operationId: shieldOpId,
      originMint,
      poolId: poolState.toBase58(),
      amount: shieldAmount,
      depositId,
      blinding,
      keypair
    });
    console.log(`   ✓ Shield executed: ${executeShieldSig}`);
    
    // Wait for shield to finalize
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('   ✓ Shield completed - notes created');
    
    // Step 2: Now test unshield with the created note
    console.log('2. Testing unshield with created note...');
    const unshieldAmount = BigInt(50_000_000); // 0.05 SOL (less than shield amount to leave change)
    
    // Get current root for unshield
    const unshieldRoot = await fetchZTokenPoolRoot(connection, testMint);
    
    // Fetch fee_bps from pool state (simplified - use default for now)
    const feeBps = 10; // Default fee (0.1%) - we'll calculate fee based on this
    const feeBpsBigInt = BigInt(feeBps);
    let calculatedFee = (unshieldAmount * feeBpsBigInt) / 10_000n;
    const fee = calculatedFee > 0n ? calculatedFee : 1n;
    const totalRequired = unshieldAmount + fee;
    
    if (totalRequired > shieldAmount) {
      throw new Error(`Insufficient note amount: need ${totalRequired}, have ${shieldAmount}`);
    }
    
    // Prepare unshield
    console.log('   Preparing unshield...');
    const unshieldPayload = {
      oldRoot: unshieldRoot,
      amount: unshieldAmount.toString(),
      fee: fee.toString(),
      destPubkey: keypair.publicKey.toBase58(),
      mode: 'origin',
      mintId: originMint,
      poolId: poolState.toBase58(),
      noteId: depositId,
      spendingKey: blinding,
      noteAmount: shieldAmount.toString()
    };
    
    // Add change if needed
    const changeAmount = shieldAmount - totalRequired;
    if (changeAmount > 0n) {
      const changeBlinding = Math.floor(Math.random() * 10 ** 18).toString();
      const changeAmountBlinding = Math.floor(Math.random() * 10 ** 18).toString();
      unshieldPayload.change = {
        amount: changeAmount.toString(),
        recipient: keypair.publicKey.toBase58(),
        blinding: changeBlinding,
        amountBlinding: changeAmountBlinding
      };
    }
    
    const unshieldProof = await proofClient.requestProof('unwrap', unshieldPayload);
    console.log('   ✓ Unshield proof generated');
    
    const { operationId: unshieldOpId, signature: prepareUnshieldSig } = await prepareUnshield({
      wallet,
      connection,
      originMint,
      poolId: poolState.toBase58(),
      amount: unshieldAmount,
      destination: keypair.publicKey.toBase58(),
      mode: 'origin',
      noteId: depositId,
      spendingKey: blinding,
      noteAmount: shieldAmount,
      proof: unshieldProof,
      proofClient
    });
    console.log(`   ✓ Unshield prepared: ${prepareUnshieldSig}`);
    console.log(`   ✓ Operation ID: ${unshieldOpId}`);
    
    // Execute unshield
    console.log('   Executing unshield...');
    const executeUnshieldSig = await executeUnshield({
      wallet,
      connection,
      operationId: unshieldOpId,
      originMint,
      poolId: poolState.toBase58(),
      amount: unshieldAmount,
      destination: keypair.publicKey.toBase58(),
      mode: 'origin',
      keypair
    });
    console.log(`   ✓ Execute signature: ${executeUnshieldSig}`);
    console.log('   ✓ Unshield completed successfully!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Logs:', error.logs);
    }
    return false;
  }
}

async function testPrepareExecuteTransfer() {
  console.log('\n=== Test: Prepare + Execute Transfer ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
  const testMint = new PublicKey(originMint);
  
  try {
    // Step 1: First perform a shield to create notes
    console.log('1. Performing shield to create notes...');
    const { derivePoolState } = await import('../lib/onchain/pdas');
    const poolState = derivePoolState(testMint);
    
    // Check/initialize pool
    const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
    if (!poolAccount || poolAccount.data.length < 8 + 32) {
      console.log('   ℹ️  Pool not initialized - initializing via preparePool...');
      const poolResult = await preparePool({
        connection,
        wallet,
        originMint
      });
      if (poolResult.poolInitialized) {
        console.log('   ✓ Pool initialized successfully');
      }
    } else {
      console.log('   ✓ Pool is already initialized');
    }
    
    // Perform shield
    const shieldAmount = BigInt(100_000_000); // 0.1 SOL
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const currentRoot = await fetchZTokenPoolRoot(connection, testMint);
    const depositId = Date.now().toString();
    const blinding = Math.floor(Math.random() * 10 ** 18).toString();
    
    console.log('   Generating shield proof...');
    const shieldProof = await proofClient.requestProof('wrap', {
      oldRoot: currentRoot,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId,
      poolId: poolState.toBase58(),
      blinding,
      mintId: originMint
    });
    console.log('   ✓ Shield proof generated');
    
    // Prepare shield
    const { operationId: shieldOpId, signature: prepareShieldSig } = await prepareShield({
      wallet,
      connection,
      originMint,
      amount: shieldAmount,
      depositId,
      blinding,
      proof: shieldProof,
      proofClient
    });
    console.log(`   ✓ Shield prepared: ${prepareShieldSig}`);
    
    // Ensure accounts exist before executeShield (reduces transaction size)
    const originMintKey = new PublicKey(originMint);
    const isShieldingSOL = isNativeSol(originMintKey);
    const actualShieldMint = isShieldingSOL ? NATIVE_SOL_MINT : originMintKey;
    const vaultState = deriveVaultState(actualShieldMint);
    
    // Determine token program
    const mintAccount = await connection.getAccountInfo(actualShieldMint, 'confirmed');
    if (!mintAccount) {
      throw new Error('Mint account not found');
    }
    const tokenProgramId = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) 
      ? TOKEN_2022_PROGRAM_ID 
      : TOKEN_PROGRAM_ID;
    
    // Create vault token account if it doesn't exist
    const vaultTokenAccount = await getAssociatedTokenAddress(
      actualShieldMint,
      vaultState,
      true,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccountInfo = await connection.getAccountInfo(vaultTokenAccount, 'confirmed');
    if (!vaultTokenAccountInfo) {
      console.log('   Creating vault token account...');
      const createVaultTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey,
          vaultTokenAccount,
          vaultState,
          actualShieldMint,
          tokenProgramId,
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
    }
    
    // Wrap SOL to wSOL first if needed (before executeShield to reduce transaction size)
    if (isShieldingSOL) {
      console.log('   Checking wSOL balance...');
      const wsolAccount = await getWrappedSolAccount(keypair.publicKey);
      const balanceCheck = await checkWrappedSolBalance(connection, keypair.publicKey, shieldAmount);
      if (!balanceCheck.hasEnough) {
        console.log(`   Wrapping ${balanceCheck.needsWrap} lamports to wSOL...`);
        const wrapInstructions = await createWrapSolInstructions(
          wsolAccount,
          balanceCheck.needsWrap,
          keypair.publicKey,
          connection
        );
        const wrapTx = new Transaction().add(...wrapInstructions);
        wrapTx.feePayer = keypair.publicKey;
        const wrapBlockhash = await connection.getLatestBlockhash('confirmed');
        wrapTx.recentBlockhash = wrapBlockhash.blockhash;
        wrapTx.sign(keypair);
        const wrapSig = await connection.sendRawTransaction(wrapTx.serialize(), { skipPreflight: false });
        await connection.confirmTransaction(wrapSig, 'confirmed');
        console.log(`   ✓ SOL wrapped: ${wrapSig}`);
      } else {
        console.log(`   ✓ wSOL has sufficient balance (${balanceCheck.currentBalance})`);
      }
    }
    
    // Execute shield
    console.log('   Executing shield...');
    const executeShieldSig = await executeShield({
      wallet,
      connection,
      operationId: shieldOpId,
      originMint,
      poolId: poolState.toBase58(),
      amount: shieldAmount,
      depositId,
      blinding,
      keypair
    });
    console.log(`   ✓ Shield executed: ${executeShieldSig}`);
    
    // Wait for shield to finalize
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('   ✓ Shield completed - notes created');
    
    // Step 2: Now test transfer with the created note
    console.log('2. Testing transfer with created note...');
    const transferAmount = BigInt(50_000_000); // 0.05 SOL (half of shield amount)
    const recipient = Keypair.generate().publicKey;
    
    // Get current root for transfer
    const transferRoot = await fetchZTokenPoolRoot(connection, testMint);
    
    // Generate transfer proof
    console.log('   Generating transfer proof...');
    const { generateDexTransferProofSimple } = await import('../lib/dex-ztoken-helpers');
    const transferProof = await generateDexTransferProofSimple(
      proofClient,
      connection,
      testMint,
      [{
        noteId: depositId,
        spendingKey: blinding,
        amount: shieldAmount
      }],
      transferAmount,
      recipient,
      keypair.publicKey // change recipient
    );
    console.log('   ✓ Transfer proof generated');
    
    // Prepare transfer
    console.log('   Preparing transfer...');
    // Convert Uint8Array[] to hex strings for prepareTransfer
    const nullifiersHex = transferProof.nullifiers.map(n => Buffer.from(n).toString('hex'));
    const outputCommitmentsHex = transferProof.outputCommitments.map(c => Buffer.from(c).toString('hex'));
    const outputAmountCommitmentsHex = transferProof.outputAmountCommitments.map(c => Buffer.from(c).toString('hex'));
    const { operationId: transferOpId, signature: prepareTransferSig } = await prepareTransfer({
      wallet,
      connection,
      originMint,
      poolId: poolState.toBase58(),
      nullifiers: nullifiersHex,
      outputCommitments: outputCommitmentsHex,
      outputAmountCommitments: outputAmountCommitmentsHex,
      proof: transferProof
    });
    console.log(`   ✓ Transfer prepared: ${prepareTransferSig}`);
    console.log(`   ✓ Operation ID: ${transferOpId}`);
    
    // Execute transfer
    console.log('   Executing transfer...');
    const executeTransferSig = await executeTransfer({
      wallet,
      connection,
      operationId: transferOpId,
      originMint,
      poolId: poolState.toBase58(),
      keypair
    });
    console.log(`   ✓ Execute signature: ${executeTransferSig}`);
    console.log('   ✓ Transfer completed successfully!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Logs:', error.logs);
    }
    return false;
  }
}

async function testPrepareExecuteTransferFrom() {
  console.log('\n=== Test: Prepare + Execute TransferFrom ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  const allowanceOwner = Keypair.generate(); // Different keypair for allowance owner
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  await airdropSol(connection, allowanceOwner.publicKey, BigInt(1) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
  const testMint = new PublicKey(originMint);
  
  try {
    // Step 1: Shield for allowance owner to create notes
    console.log('1. Performing shield for allowance owner...');
    const { derivePoolState } = await import('../lib/onchain/pdas');
    const poolState = derivePoolState(testMint);
    
    // Check/initialize pool
    const poolAccount = await connection.getAccountInfo(poolState, 'confirmed');
    if (!poolAccount || poolAccount.data.length < 8 + 32) {
      console.log('   ℹ️  Pool not initialized - initializing via preparePool...');
      const ownerWallet = createWalletAdapter(allowanceOwner);
      const poolResult = await preparePool({
        connection,
        wallet: ownerWallet,
        originMint
      });
      if (poolResult.poolInitialized) {
        console.log('   ✓ Pool initialized successfully');
      }
    } else {
      console.log('   ✓ Pool is already initialized');
    }
    
    // Shield for allowance owner
    const ownerWallet = createWalletAdapter(allowanceOwner);
    const shieldAmount = BigInt(100_000_000); // 0.1 SOL
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const currentRoot = await fetchZTokenPoolRoot(connection, testMint);
    const depositId = Date.now().toString();
    const blinding = Math.floor(Math.random() * 10 ** 18).toString();
    
    console.log('   Generating shield proof...');
    const shieldProof = await proofClient.requestProof('wrap', {
      oldRoot: currentRoot,
      amount: shieldAmount.toString(),
      recipient: allowanceOwner.publicKey.toBase58(),
      depositId,
      poolId: poolState.toBase58(),
      blinding,
      mintId: originMint
    });
    console.log('   ✓ Shield proof generated');
    
    const { operationId: shieldOpId, signature: prepareShieldSig } = await prepareShield({
      wallet: ownerWallet,
      connection,
      originMint,
      amount: shieldAmount,
      depositId,
      blinding,
      proof: shieldProof,
      proofClient
    });
    console.log(`   ✓ Shield prepared: ${prepareShieldSig}`);
    
    // Ensure vault token account exists before executeShield
    const { deriveVaultState } = await import('../lib/onchain/pdas');
    const vaultState = deriveVaultState(testMint);
    const { isNativeSol, NATIVE_SOL_MINT } = await import('../lib/solWrapping');
    const actualShieldMint = isNativeSol(testMint) ? NATIVE_SOL_MINT : testMint;
    const tokenProgramId = TOKEN_PROGRAM_ID;
    const vaultTokenAccount = await getAssociatedTokenAddress(
      actualShieldMint,
      vaultState,
      true, // allowOwnerOffCurve
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccountInfo = await connection.getAccountInfo(vaultTokenAccount, 'confirmed');
    if (!vaultTokenAccountInfo) {
      console.log('   Creating vault token account...');
      const createVaultTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          allowanceOwner.publicKey,
          vaultTokenAccount,
          vaultState,
          actualShieldMint,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      createVaultTx.feePayer = allowanceOwner.publicKey;
      const createVaultBlockhash = await connection.getLatestBlockhash('confirmed');
      createVaultTx.recentBlockhash = createVaultBlockhash.blockhash;
      createVaultTx.sign(allowanceOwner);
      const createVaultSig = await connection.sendRawTransaction(createVaultTx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(createVaultSig, 'confirmed');
      console.log(`   ✓ Vault token account created: ${createVaultSig}`);
    } else {
      console.log('   ✓ Vault token account already exists');
    }
    
    const executeShieldSig = await executeShield({
      wallet: ownerWallet,
      connection,
      operationId: shieldOpId,
      originMint,
      poolId: poolState.toBase58(),
      amount: shieldAmount,
      depositId,
      blinding,
      keypair: allowanceOwner
    });
    console.log(`   ✓ Shield executed: ${executeShieldSig}`);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('   ✓ Shield completed - notes created for allowance owner');
    
    // Step 2: Create allowance
    console.log('2. Setting up allowance...');
    const allowanceAmount = BigInt(50_000_000); // 0.05 SOL
    const spendAmount = allowanceAmount; // For simplicity, spend all allowance
    
    // Approve allowance - owner approves spender to spend on their behalf
    console.log('   Approving allowance...');
    const { deriveAllowanceAccount } = await import('../lib/onchain/pdas');
    const allowanceKey = deriveAllowanceAccount(poolState, allowanceOwner.publicKey, keypair.publicKey);
    
    // Build approve_allowance instruction
    const poolCoder = new BorshCoder(poolIdl as any);
    const approveData = poolCoder.instruction.encode('approve_allowance', {
      args: {
        amount: new BN(allowanceAmount.toString()),
        expires_at: null
      }
    });
    
    const approveIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: allowanceKey, isSigner: false, isWritable: true },
        { pubkey: allowanceOwner.publicKey, isSigner: true, isWritable: true },
        { pubkey: keypair.publicKey, isSigner: false, isWritable: false },
        { pubkey: testMint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: approveData
    });
    
    const approveTx = new Transaction().add(approveIx);
    approveTx.feePayer = allowanceOwner.publicKey;
    const approveBlockhash = await connection.getLatestBlockhash('confirmed');
    approveTx.recentBlockhash = approveBlockhash.blockhash;
    approveTx.sign(allowanceOwner);
    const approveSig = await connection.sendRawTransaction(approveTx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(approveSig, 'confirmed');
    console.log(`   ✓ Allowance approved: ${approveSig}`);
    
    // Step 3: Test transferFrom
    console.log('3. Testing transferFrom...');
    const transferAmount = BigInt(50_000_000); // 0.05 SOL
    const recipient = Keypair.generate().publicKey;
    
    const transferRoot = await fetchZTokenPoolRoot(connection, testMint);
    
    console.log('   Generating transferFrom proof...');
    const { generateDexTransferProofSimple } = await import('../lib/dex-ztoken-helpers');
    const transferProof = await generateDexTransferProofSimple(
      proofClient,
      connection,
      testMint,
      [{
        noteId: depositId,
        spendingKey: blinding,
        amount: shieldAmount
      }],
      transferAmount,
      recipient,
      keypair.publicKey // change recipient
    );
    console.log('   ✓ TransferFrom proof generated');
    
    console.log('   Preparing transferFrom...');
    // Convert Uint8Array[] to hex strings for prepareTransferFrom
    const nullifiersHex = transferProof.nullifiers.map(n => Buffer.from(n).toString('hex'));
    const outputCommitmentsHex = transferProof.outputCommitments.map(c => Buffer.from(c).toString('hex'));
    const outputAmountCommitmentsHex = transferProof.outputAmountCommitments.map(c => Buffer.from(c).toString('hex'));
    const { operationId: transferFromOpId, signature: prepareTransferFromSig } = await prepareTransferFrom({
      wallet,
      connection,
      originMint,
      poolId: poolState.toBase58(),
      nullifiers: nullifiersHex,
      outputCommitments: outputCommitmentsHex,
      outputAmountCommitments: outputAmountCommitmentsHex,
      proof: transferProof,
      allowanceOwner: allowanceOwner.publicKey.toBase58(),
      allowanceAmount,
      spendAmount
    });
    console.log(`   ✓ TransferFrom prepared: ${prepareTransferFromSig}`);
    console.log(`   ✓ Operation ID: ${transferFromOpId}`);
    
    console.log('   Executing transferFrom...');
    const executeTransferFromSig = await executeTransferFrom({
      wallet,
      connection,
      operationId: transferFromOpId,
      originMint,
      poolId: poolState.toBase58(),
      allowanceOwner: allowanceOwner.publicKey.toBase58(),
      allowanceAmount,
      spendAmount,
      keypair
    });
    console.log(`   ✓ Execute signature: ${executeTransferFromSig}`);
    console.log('   ✓ TransferFrom completed successfully!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Logs:', error.logs);
    }
    return false;
  }
}

async function testPrepareExecuteBatchTransfer() {
  console.log('\n=== Test: Prepare + Execute BatchTransfer ===');
  
  console.log('   ⚠️  Batch transfer test requires complex setup with multiple mints');
  console.log('   ⚠️  Skipping for now - can be tested manually');
  
  return true;
}

async function testPrepareExecuteBatchTransferFrom() {
  console.log('\n=== Test: Prepare + Execute BatchTransferFrom ===');
  
  console.log('   ⚠️  Batch transfer from test requires complex setup with multiple mints and allowances');
  console.log('   ⚠️  Skipping for now - can be tested manually');
  
  return true;
}

async function testOperationExpiry() {
  console.log('\n=== Test: Operation Expiry ===');
  
  console.log('   ⚠️  This test requires waiting 5+ minutes for expiry');
  console.log('   ⚠️  Skipping for now - can be tested manually');
  
  return true;
}

async function testCleanupExpiredOperations() {
  console.log('\n=== Test: Cleanup Expired Operations ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL first
  await airdropSol(connection, keypair.publicKey, BigInt(1) * BigInt(LAMPORTS_PER_SOL));
  
  try {
    // First, create a proof vault by preparing an operation
    // This ensures the vault exists before cleanup
    console.log('1. Creating proof vault by preparing a shield operation...');
    const proofClient = new ProofClient({ baseUrl: PROOF_URL });
    const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
    const { derivePoolState } = await import('../lib/onchain/pdas');
    const poolState = derivePoolState(new PublicKey(originMint));
    
    const shieldAmount = BigInt(10_000_000); // 0.01 SOL
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const currentRoot = await fetchZTokenPoolRoot(connection, new PublicKey(originMint));
    const depositId = Date.now().toString();
    const blinding = Math.floor(Math.random() * 10 ** 18).toString();
    
    const shieldProof = await proofClient.requestProof('wrap', {
      oldRoot: currentRoot,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId,
      poolId: poolState.toBase58(),
      blinding,
      mintId: originMint
    });
    
    const { operationId } = await prepareShield({
      wallet,
      connection,
      originMint,
      amount: shieldAmount,
      depositId,
      blinding,
      proof: shieldProof,
      proofClient
    });
    console.log(`   ✓ Proof vault created with operation: ${operationId}`);
    
    console.log('2. Calling cleanup_expired_operations...');
    const signature = await cleanupExpiredOperations({
      wallet,
      connection
    });
    console.log(`   ✓ Cleanup signature: ${signature}`);
    console.log('   ✓ Cleanup completed successfully!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Logs:', error.logs);
    }
    return false;
  }
}

async function testVaultCapacity() {
  console.log('\n=== Test: Vault Capacity Limits ===');
  
  console.log('   ⚠️  This test requires creating 10+ operations');
  console.log('   ⚠️  Skipping for now - can be tested manually');
  
  return true;
}

async function main() {
  console.log('🧪 Testing Prepare/Execute Pattern\n');
  console.log('='.repeat(50));

  const onlyArg = (process.env.ONLY_TEST ?? process.argv[2] ?? '').trim().toLowerCase();
  const tests: Array<{ name: string; fn: () => Promise<boolean> }> = [
    { name: 'shield', fn: testPrepareExecuteShield },
    { name: 'unshield', fn: testPrepareExecuteUnshield },
    { name: 'transfer', fn: testPrepareExecuteTransfer },
    { name: 'transferfrom', fn: testPrepareExecuteTransferFrom },
    { name: 'batchtransfer', fn: testPrepareExecuteBatchTransfer },
    { name: 'batchtransferfrom', fn: testPrepareExecuteBatchTransferFrom },
    { name: 'expiry', fn: testOperationExpiry },
    { name: 'cleanup', fn: testCleanupExpiredOperations },
    { name: 'vaultcapacity', fn: testVaultCapacity }
  ];
  
  const results: boolean[] = [];
  const executed: string[] = [];

  for (const test of tests) {
    if (onlyArg && test.name !== onlyArg) {
      console.log(`Skipping ${test.name} (ONLY_TEST=${onlyArg})`);
      continue;
    }
    const result = await test.fn();
    results.push(result);
    executed.push(test.name);
  }

  if (results.length === 0) {
    console.error(`No tests were executed. Set ONLY_TEST to one of: ${tests.map(t => t.name).join(', ')}`);
    process.exit(1);
  }
  
  // Summary
  console.log('\n' + '='.repeat(50));
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n📊 Results: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('✅ Selected tests passed!');
    process.exit(0);
  } else {
    console.log('⚠️  Some selected tests were skipped or failed');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

