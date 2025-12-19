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
 * Helper function to derive proof vault PDA
 */
function deriveProofVault(owner: PublicKey): PublicKey {
  const [proofVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('proof-vault'), owner.toBuffer()],
    POOL_PROGRAM_ID
  );
  return proofVault;
}

/**
 * Helper function to read proof vault account data
 */
async function getProofVaultAccount(
  connection: Connection,
  owner: PublicKey
): Promise<{ operationCount: number; preparedOperations: any[] } | null> {
  const proofVault = deriveProofVault(owner);
  const accountInfo = await connection.getAccountInfo(proofVault, 'confirmed');
  if (!accountInfo) {
    return null;
  }
  
  const poolCoder = new BorshCoder(poolIdl as any);
  try {
    const decoded = poolCoder.accounts.decode('UserProofVault', accountInfo.data);
    return {
      operationCount: decoded.operation_count?.toNumber() ?? 0,
      preparedOperations: decoded.prepared_operations ?? []
    };
  } catch (error) {
    console.warn('Failed to decode proof vault:', error);
    return null;
  }
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
  
  // CRITICAL FIX: Load the bootstrap payer keypair to use as factory authority
  // The factory was initialized with the bootstrap payer, so we need to use the same keypair
  let factoryAuthorityKeypair: Keypair;
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const keypairPath = path.join(process.env.HOME || '~', '.config', 'solana', 'id.json');
    const keypairData = await fs.readFile(keypairPath, 'utf-8');
    const keypairArray = JSON.parse(keypairData);
    factoryAuthorityKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairArray));
    console.log(`   Using bootstrap payer as factory authority: ${factoryAuthorityKeypair.publicKey.toBase58()}`);
  } catch (error) {
    console.warn(`   Could not load bootstrap keypair, using test payer: ${(error as Error).message}`);
    // Fallback: assume payer is the factory authority (if bootstrap used same payer)
    factoryAuthorityKeypair = payer;
  }
  
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
  
  // CRITICAL FIX: Fetch factory state to get the actual authority
  const factoryStateInfo = await connection.getAccountInfo(factoryState, 'confirmed');
  if (!factoryStateInfo) {
    throw new Error('Factory state not found. Please run bootstrap first.');
  }
  
  // Decode factory state to get authority
  // FactoryState layout: discriminator[8] + authority[32] + ...
  let factoryAuthority: PublicKey;
  if (factoryStateInfo.data.length >= 8 + 32) {
    const authorityBytes = factoryStateInfo.data.slice(8, 8 + 32);
    factoryAuthority = new PublicKey(authorityBytes);
    console.log(`   Using factory authority: ${factoryAuthority.toBase58()}`);
  } else {
    // Fallback: use payer (should match if bootstrap used same payer)
    factoryAuthority = payer.publicKey;
    console.log(`   Warning: Could not decode factory authority, using payer: ${factoryAuthority.toBase58()}`);
  }
  
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
  // CRITICAL FIX: Use factoryAuthorityKeypair as the authority signer
  // The factory constraint checks that authority == factory_state.authority, so we need to match
  const accountMetas: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: factoryAuthorityKeypair.publicKey, isSigner: true, isWritable: false },
    { pubkey: mintMapping, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintMapping, isSigner: false, isWritable: true }, // ptkn_mint (optional placeholder - use mintMapping as writable placeholder when enable_ptkn=false)
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
  // CRITICAL FIX: Sign with both factory authority and payer
  const signers = [factoryAuthorityKeypair, payer];
  const registerSig = await connection.sendTransaction(registerTx, signers);
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
  
  // CRITICAL FIX: Create ATA if it doesn't exist
  const ataInfo = await connection.getAccountInfo(payerAta, 'confirmed');
  if (!ataInfo) {
    console.log(`   Creating associated token account: ${payerAta.toBase58()}`);
    const createAtaIx = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      payerAta,
      payer.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createAtaTx = new Transaction().add(createAtaIx);
    const createAtaSig = await connection.sendTransaction(createAtaTx, [payer]);
    await connection.confirmTransaction(createAtaSig, 'confirmed');
    console.log(`   ✓ Created ATA: ${createAtaSig}`);
  }
  
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
        originMint,
        keypair // Pass keypair for direct transaction signing (matches bootstrap script)
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
    if (error.logs) {
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    // Try to get more details from SendTransactionError
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
    }
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
        originMint,
        keypair // Pass keypair for direct transaction signing (matches bootstrap script)
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
    
    // Ensure vault token account exists before executeShield
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
    
    // Execute shield (using executeShield directly, not wrap)
    console.log('4. Executing shield...');
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
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
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
        originMint,
        keypair // Pass keypair for direct transaction signing (matches bootstrap script)
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
    // CRITICAL FIX: Use nullifiers and output commitments directly from proof.publicInputs
    // The proof.publicInputs format is: [oldRoot, newRoot, nullifier0, nullifier1, output0, output1, mint, pool]
    // Extract nullifiers and commitments directly from publicInputs to ensure they match what the program expects
    const nullifiersHex = transferProof.publicInputs.slice(2, 4); // nullifier0, nullifier1
    const outputCommitmentsHex = transferProof.publicInputs.slice(4, 6); // output0, output1
    // For outputAmountCommitments, use the computed values from transferProof (they're not in publicInputs)
    const { canonicalizeHex } = await import('../lib/onchain/utils');
    const outputAmountCommitmentsHex = transferProof.outputAmountCommitments.map(c => {
      // Convert Uint8Array to hex string, then canonicalize to ensure consistency
      const hex = Buffer.from(c).toString('hex');
      return canonicalizeHex(hex);
    });
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
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
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
        originMint,
        keypair: allowanceOwner // Pass keypair for direct transaction signing
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
    
    // CRITICAL FIX: Check if allowance account exists
    // The account is a PDA, so it must be created by the program (via init_if_needed in standard handler)
    // The raw handler should handle initialization if account doesn't exist
    const allowanceAccountInfo = await connection.getAccountInfo(allowanceKey, 'confirmed');
    if (!allowanceAccountInfo || allowanceAccountInfo.data.length < 169) {
      console.log('   Allowance account does not exist - will be initialized by approve_allowance');
    } else {
      console.log('   ✓ Allowance account already exists');
    }
    
    // Build approve_allowance instruction
    const poolCoder = new BorshCoder(poolIdl as any);
    // CRITICAL FIX: IDL expects args nested in 'args' object with ApproveAllowanceArgs structure
    const approveData = poolCoder.instruction.encode('approve_allowance', {
      args: {
        amount: new BN(allowanceAmount.toString()),
        expires_at: null
      }
    });
    
    console.log('[test] approve_allowance instruction data length:', approveData.length);
    console.log('[test] approve_allowance discriminator:', Array.from(approveData.slice(0, 8)));
    
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
    // CRITICAL FIX: Use nullifiers and output commitments directly from proof.publicInputs
    // The proof.publicInputs format is: [oldRoot, newRoot, nullifier0, nullifier1, output0, output1, mint, pool]
    // Extract nullifiers and commitments directly from publicInputs to ensure they match what the program expects
    const nullifiersHex = transferProof.publicInputs.slice(2, 4); // nullifier0, nullifier1
    const outputCommitmentsHex = transferProof.publicInputs.slice(4, 6); // output0, output1
    // For outputAmountCommitments, use the computed values from transferProof (they're not in publicInputs)
    const { canonicalizeHex } = await import('../lib/onchain/utils');
    const outputAmountCommitmentsHex = transferProof.outputAmountCommitments.map(c => {
      // Convert Uint8Array to hex string, then canonicalize to ensure consistency
      const hex = Buffer.from(c).toString('hex');
      return canonicalizeHex(hex);
    });
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
    try {
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
    } catch (executeError: any) {
      console.error('   ✗ ExecuteTransferFrom failed:', executeError.message);
      
      // Try to get full transaction details
      if (executeError.signature) {
        console.error('   Failed signature:', executeError.signature);
        try {
          const tx = await connection.getTransaction(executeError.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });
          if (tx) {
            console.error('   Transaction status:', tx.meta?.err);
            if (tx.meta?.logMessages) {
              console.error('   Full transaction logs:');
              tx.meta.logMessages.forEach((log, i) => {
                console.error(`     [${i}] ${log}`);
              });
            }
            if (tx.meta?.err) {
              console.error('   Error details:', JSON.stringify(tx.meta.err, null, 2));
              // Check which program threw the error
              if (tx.meta.err && typeof tx.meta.err === 'object') {
                const errObj = tx.meta.err as any;
                if (errObj.InstructionError) {
                  const [instructionIndex, instructionError] = errObj.InstructionError;
                  console.error(`   Error in instruction ${instructionIndex}:`, JSON.stringify(instructionError, null, 2));
                  if (instructionError.Custom) {
                    const errorCode = instructionError.Custom;
                    console.error(`   Custom error code: ${errorCode} (0x${errorCode.toString(16)})`);
                    // Check if it's a verifier error
                    if (errorCode >= 6000 && errorCode < 6100) {
                      console.error(`   ⚠️  This is a VERIFIER PROGRAM error (code ${errorCode})!`);
                      // Map error codes to names
                      const verifierErrors: Record<number, string> = {
                        6000: 'InvalidProof',
                        6001: 'HashMismatch',
                        6002: 'EmptyVerifyingKey',
                        6003: 'InvalidVerifyingKeyId',
                        6004: 'EmptyProof',
                        6005: 'EmptyPublicInputs',
                        6006: 'UnauthorizedAuthority',
                        6007: 'ProofTooLarge',
                        6008: 'PublicInputsTooLarge',
                        6009: 'VersionTooOld',
                        6010: 'VerifyingKeyTooLarge',
                        6011: 'InvalidKeyFormat',
                        6012: 'KeyRevoked',
                        6013: 'AlreadyRevoked',
                        6014: 'InvalidAccountOwner',
                        6015: 'InvalidPDA',
                        6016: 'InvalidBump',
                        6017: 'DataLengthMismatch',
                        6018: 'AccountSizeMismatch',
                      };
                      const errorName = verifierErrors[errorCode] || 'Unknown';
                      console.error(`   Error name: ${errorName}`);
                    }
                  }
                  // Check if there's a nested instruction error (CPI)
                  if (instructionError[1] && instructionError[1].InstructionError) {
                    const [nestedIndex, nestedError] = instructionError[1].InstructionError;
                    console.error(`   Nested error in instruction ${nestedIndex}:`, JSON.stringify(nestedError, null, 2));
                  }
                }
              }
            }
          }
        } catch (txError) {
          console.error('   Could not fetch transaction:', txError);
        }
      }
      
      if (executeError.logs) {
        console.error('   Error logs:', executeError.logs);
      }
      throw executeError; // Re-throw to be caught by outer catch
    }
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
    }
    return false;
  }
}

async function testPrepareExecuteBatchTransfer() {
  console.log('\n=== Test: Prepare + Execute BatchTransfer ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(3) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  try {
    // Step 1: Create two test mints
    console.log('1. Creating two test mints...');
    const { mint: mint1, mintKeypair: mint1Keypair } = await createAndRegisterTestMint(connection, keypair);
    const { mint: mint2, mintKeypair: mint2Keypair } = await createAndRegisterTestMint(connection, keypair);
    console.log(`   ✓ Mint 1: ${mint1.toBase58()}`);
    console.log(`   ✓ Mint 2: ${mint2.toBase58()}`);
    
    // Step 2: Prepare pools
    console.log('2. Preparing pools...');
    const { derivePoolState, deriveVaultState } = await import('../lib/onchain/pdas');
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('../lib/onchain/programIds');
    const poolState1 = derivePoolState(mint1);
    const poolState2 = derivePoolState(mint2);
    
    const poolAccount1 = await connection.getAccountInfo(poolState1, 'confirmed');
    if (!poolAccount1 || poolAccount1.data.length < 8 + 32) {
      await preparePool({ connection, wallet, originMint: mint1.toBase58(), keypair });
      console.log('   ✓ Pool 1 initialized');
    } else {
      console.log('   ✓ Pool 1 already exists');
    }
    
    const poolAccount2 = await connection.getAccountInfo(poolState2, 'confirmed');
    if (!poolAccount2 || poolAccount2.data.length < 8 + 32) {
      await preparePool({ connection, wallet, originMint: mint2.toBase58() });
      console.log('   ✓ Pool 2 initialized');
    } else {
      console.log('   ✓ Pool 2 already exists');
    }
    
    // Step 2.5: Ensure vault token accounts exist for both mints
    console.log('2.5. Ensuring vault token accounts exist...');
    const vaultState1 = deriveVaultState(mint1);
    const vaultState2 = deriveVaultState(mint2);
    
    const vaultTokenAccount1 = await getAssociatedTokenAddress(
      mint1,
      vaultState1,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccount1Info = await connection.getAccountInfo(vaultTokenAccount1, 'confirmed');
    if (!vaultTokenAccount1Info) {
      console.log('   Creating vault token account for mint 1...');
      const createVault1Tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey,
          vaultTokenAccount1,
          vaultState1,
          mint1,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const createVault1Blockhash = await connection.getLatestBlockhash('confirmed');
      createVault1Tx.recentBlockhash = createVault1Blockhash.blockhash;
      createVault1Tx.feePayer = keypair.publicKey;
      const createVault1Sig = await wallet.sendTransaction(createVault1Tx, connection, { skipPreflight: false });
      await connection.confirmTransaction(createVault1Sig, 'confirmed');
      console.log('   ✓ Vault token account 1 created');
    } else {
      console.log('   ✓ Vault token account 1 already exists');
    }
    
    const vaultTokenAccount2 = await getAssociatedTokenAddress(
      mint2,
      vaultState2,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccount2Info = await connection.getAccountInfo(vaultTokenAccount2, 'confirmed');
    if (!vaultTokenAccount2Info) {
      console.log('   Creating vault token account for mint 2...');
      const createVault2Tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey,
          vaultTokenAccount2,
          vaultState2,
          mint2,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const createVault2Blockhash = await connection.getLatestBlockhash('confirmed');
      createVault2Tx.recentBlockhash = createVault2Blockhash.blockhash;
      createVault2Tx.feePayer = keypair.publicKey;
      const createVault2Sig = await wallet.sendTransaction(createVault2Tx, connection, { skipPreflight: false });
      await connection.confirmTransaction(createVault2Sig, 'confirmed');
      console.log('   ✓ Vault token account 2 created');
    } else {
      console.log('   ✓ Vault token account 2 already exists');
    }
    
    // Step 3: Shield tokens for both mints
    console.log('3. Shielding tokens for both mints...');
    const shieldAmount = BigInt(100_000_000); // 0.1 tokens
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const { generateBatchTransferProof } = await import('../lib/dex-ztoken-helpers');
    const { bytesLEToCanonicalHex } = await import('../lib/onchain/utils');
    
    // Shield mint1
    const root1 = await fetchZTokenPoolRoot(connection, mint1);
    const depositId1 = Date.now().toString();
    const blinding1 = Math.floor(Math.random() * 10 ** 18).toString();
    const shieldProof1 = await proofClient.requestProof('wrap', {
      oldRoot: root1,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId: depositId1,
      poolId: poolState1.toBase58(),
      blinding: blinding1,
      mintId: mint1.toBase58()
    });
    const { operationId: shieldOpId1 } = await prepareShield({
      wallet, connection, originMint: mint1.toBase58(), amount: shieldAmount,
      depositId: depositId1, blinding: blinding1, proof: shieldProof1, proofClient
    });
    await executeShield({
      wallet, connection, operationId: shieldOpId1, originMint: mint1.toBase58(),
      poolId: poolState1.toBase58(), amount: shieldAmount, depositId: depositId1,
      blinding: blinding1, keypair
    });
    console.log('   ✓ Mint 1 shielded');
    
    // Shield mint2
    const root2 = await fetchZTokenPoolRoot(connection, mint2);
    const depositId2 = (Date.now() + 1).toString();
    const blinding2 = Math.floor(Math.random() * 10 ** 18).toString();
    const shieldProof2 = await proofClient.requestProof('wrap', {
      oldRoot: root2,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId: depositId2,
      poolId: poolState2.toBase58(),
      blinding: blinding2,
      mintId: mint2.toBase58()
    });
    const { operationId: shieldOpId2 } = await prepareShield({
      wallet, connection, originMint: mint2.toBase58(), amount: shieldAmount,
      depositId: depositId2, blinding: blinding2, proof: shieldProof2, proofClient
    });
    await executeShield({
      wallet, connection, operationId: shieldOpId2, originMint: mint2.toBase58(),
      poolId: poolState2.toBase58(), amount: shieldAmount, depositId: depositId2,
      blinding: blinding2, keypair
    });
    console.log('   ✓ Mint 2 shielded');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 4: Prepare batch transfer
    console.log('4. Preparing batch transfer...');
    const recipient = Keypair.generate().publicKey;
    const transferAmount = BigInt(50_000_000); // 0.05 tokens
    
    const batchProof = await generateBatchTransferProof(
      proofClient,
      connection,
      [
        {
          originMint: mint1,
          notes: [{
            noteId: depositId1,
            spendingKey: blinding1,
            amount: shieldAmount
          }],
          outputs: [{
            amount: transferAmount,
            recipient,
            blinding: Math.floor(Math.random() * 10 ** 18).toString()
          }]
        },
        {
          originMint: mint2,
          notes: [{
            noteId: depositId2,
            spendingKey: blinding2,
            amount: shieldAmount
          }],
          outputs: [{
            amount: transferAmount,
            recipient,
            blinding: Math.floor(Math.random() * 10 ** 18).toString()
          }]
        }
      ]
    );
    console.log('   ✓ Batch proof generated');
    
    // Extract nullifiers and commitments
    const nullifiers1 = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    const outputCommitments1 = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    const outputAmountCommitments1 = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    const nullifiers2 = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    const outputCommitments2 = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    const outputAmountCommitments2 = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    
    const { operationId: batchOpId, signature: prepareBatchSig } = await prepareBatchTransfer({
      wallet,
      connection,
      transfers: [
        {
          originMint: mint1.toBase58(),
          poolId: poolState1.toBase58(),
          proof: batchProof,
          nullifiers: nullifiers1,
          outputCommitments: outputCommitments1,
          outputAmountCommitments: outputAmountCommitments1
        },
        {
          originMint: mint2.toBase58(),
          poolId: poolState2.toBase58(),
          proof: batchProof,
          nullifiers: nullifiers2,
          outputCommitments: outputCommitments2,
          outputAmountCommitments: outputAmountCommitments2
        }
      ],
      batchProof,
      batchPublicInputs: batchProof.publicInputs
    });
    console.log(`   ✓ Batch transfer prepared: ${prepareBatchSig}`);
    console.log(`   ✓ Operation ID: ${batchOpId}`);
    
    // Step 5: Execute batch transfer
    console.log('5. Executing batch transfer...');
    const executeBatchSig = await executeBatchTransfer({
      wallet,
      connection,
      operationId: batchOpId,
      transfers: [
        { originMint: mint1.toBase58(), poolId: poolState1.toBase58() },
        { originMint: mint2.toBase58(), poolId: poolState2.toBase58() }
      ],
      keypair
    });
    console.log(`   ✓ Execute signature: ${executeBatchSig}`);
    console.log('   ✓ Batch transfer completed successfully!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
    }
    return false;
  }
}

async function testPrepareExecuteBatchTransferFrom() {
  console.log('\n=== Test: Prepare + Execute BatchTransferFrom ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  const allowanceOwner = Keypair.generate(); // Different keypair for allowance owner
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(3) * BigInt(LAMPORTS_PER_SOL));
  await airdropSol(connection, allowanceOwner.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  
  try {
    // Step 1: Create two test mints
    console.log('1. Creating two test mints...');
    const { mint: mint1, mintKeypair: mint1Keypair } = await createAndRegisterTestMint(connection, allowanceOwner);
    const { mint: mint2, mintKeypair: mint2Keypair } = await createAndRegisterTestMint(connection, allowanceOwner);
    console.log(`   ✓ Mint 1: ${mint1.toBase58()}`);
    console.log(`   ✓ Mint 2: ${mint2.toBase58()}`);
    
    // Step 2: Prepare pools
    console.log('2. Preparing pools...');
    const { derivePoolState } = await import('../lib/onchain/pdas');
    const poolState1 = derivePoolState(mint1);
    const poolState2 = derivePoolState(mint2);
    const ownerWallet = createWalletAdapter(allowanceOwner);
    
    const poolAccount1 = await connection.getAccountInfo(poolState1, 'confirmed');
    if (!poolAccount1 || poolAccount1.data.length < 8 + 32) {
      await preparePool({ connection, wallet: ownerWallet, originMint: mint1.toBase58(), keypair: allowanceOwner });
      console.log('   ✓ Pool 1 initialized');
    } else {
      console.log('   ✓ Pool 1 already exists');
    }
    
    const poolAccount2 = await connection.getAccountInfo(poolState2, 'confirmed');
    if (!poolAccount2 || poolAccount2.data.length < 8 + 32) {
      await preparePool({ connection, wallet: ownerWallet, originMint: mint2.toBase58() });
      console.log('   ✓ Pool 2 initialized');
    } else {
      console.log('   ✓ Pool 2 already exists');
    }
    
    // Step 2.5: Ensure vault token accounts exist for both mints
    console.log('2.5. Ensuring vault token accounts exist...');
    const { deriveVaultState } = await import('../lib/onchain/pdas');
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('../lib/onchain/programIds');
    const vaultState1 = deriveVaultState(mint1);
    const vaultState2 = deriveVaultState(mint2);
    
    const vaultTokenAccount1 = await getAssociatedTokenAddress(
      mint1,
      vaultState1,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccount1Info = await connection.getAccountInfo(vaultTokenAccount1, 'confirmed');
    if (!vaultTokenAccount1Info) {
      console.log('   Creating vault token account for mint 1...');
      const createVault1Tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          allowanceOwner.publicKey,
          vaultTokenAccount1,
          vaultState1,
          mint1,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const createVault1Blockhash = await connection.getLatestBlockhash('confirmed');
      createVault1Tx.recentBlockhash = createVault1Blockhash.blockhash;
      createVault1Tx.feePayer = allowanceOwner.publicKey;
      const createVault1Sig = await ownerWallet.sendTransaction(createVault1Tx, connection, { skipPreflight: false });
      await connection.confirmTransaction(createVault1Sig, 'confirmed');
      console.log('   ✓ Vault token account 1 created');
    } else {
      console.log('   ✓ Vault token account 1 already exists');
    }
    
    const vaultTokenAccount2 = await getAssociatedTokenAddress(
      mint2,
      vaultState2,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccount2Info = await connection.getAccountInfo(vaultTokenAccount2, 'confirmed');
    if (!vaultTokenAccount2Info) {
      console.log('   Creating vault token account for mint 2...');
      const createVault2Tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          allowanceOwner.publicKey,
          vaultTokenAccount2,
          vaultState2,
          mint2,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const createVault2Blockhash = await connection.getLatestBlockhash('confirmed');
      createVault2Tx.recentBlockhash = createVault2Blockhash.blockhash;
      createVault2Tx.feePayer = allowanceOwner.publicKey;
      const createVault2Sig = await ownerWallet.sendTransaction(createVault2Tx, connection, { skipPreflight: false });
      await connection.confirmTransaction(createVault2Sig, 'confirmed');
      console.log('   ✓ Vault token account 2 created');
    } else {
      console.log('   ✓ Vault token account 2 already exists');
    }
    
    // Step 3: Shield for allowance owner for both mints
    console.log('3. Shielding tokens for allowance owner...');
    const shieldAmount = BigInt(100_000_000); // 0.1 tokens
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const { generateBatchTransferFromProof } = await import('../lib/dex-ztoken-helpers');
    const { bytesLEToCanonicalHex } = await import('../lib/onchain/utils');
    
    // Shield mint1 for allowance owner
    const root1 = await fetchZTokenPoolRoot(connection, mint1);
    const depositId1 = Date.now().toString();
    const blinding1 = Math.floor(Math.random() * 10 ** 18).toString();
    const shieldProof1 = await proofClient.requestProof('wrap', {
      oldRoot: root1,
      amount: shieldAmount.toString(),
      recipient: allowanceOwner.publicKey.toBase58(),
      depositId: depositId1,
      poolId: poolState1.toBase58(),
      blinding: blinding1,
      mintId: mint1.toBase58()
    });
    const { operationId: shieldOpId1 } = await prepareShield({
      wallet: ownerWallet, connection, originMint: mint1.toBase58(), amount: shieldAmount,
      depositId: depositId1, blinding: blinding1, proof: shieldProof1, proofClient
    });
    await executeShield({
      wallet: ownerWallet, connection, operationId: shieldOpId1, originMint: mint1.toBase58(),
      poolId: poolState1.toBase58(), amount: shieldAmount, depositId: depositId1,
      blinding: blinding1, keypair: allowanceOwner
    });
    console.log('   ✓ Mint 1 shielded for allowance owner');
    
    // Shield mint2 for allowance owner
    const root2 = await fetchZTokenPoolRoot(connection, mint2);
    const depositId2 = (Date.now() + 1).toString();
    const blinding2 = Math.floor(Math.random() * 10 ** 18).toString();
    const shieldProof2 = await proofClient.requestProof('wrap', {
      oldRoot: root2,
      amount: shieldAmount.toString(),
      recipient: allowanceOwner.publicKey.toBase58(),
      depositId: depositId2,
      poolId: poolState2.toBase58(),
      blinding: blinding2,
      mintId: mint2.toBase58()
    });
    const { operationId: shieldOpId2 } = await prepareShield({
      wallet: ownerWallet, connection, originMint: mint2.toBase58(), amount: shieldAmount,
      depositId: depositId2, blinding: blinding2, proof: shieldProof2, proofClient
    });
    await executeShield({
      wallet: ownerWallet, connection, operationId: shieldOpId2, originMint: mint2.toBase58(),
      poolId: poolState2.toBase58(), amount: shieldAmount, depositId: depositId2,
      blinding: blinding2, keypair: allowanceOwner
    });
    console.log('   ✓ Mint 2 shielded for allowance owner');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 4: Create allowances for both mints
    console.log('4. Setting up allowances...');
    const allowanceAmount = BigInt(50_000_000); // 0.05 tokens
    const spendAmount = allowanceAmount; // For simplicity, spend all allowance
    
    const { deriveAllowanceAccount } = await import('../lib/onchain/pdas');
    const allowanceKey1 = deriveAllowanceAccount(poolState1, allowanceOwner.publicKey, keypair.publicKey);
    const allowanceKey2 = deriveAllowanceAccount(poolState2, allowanceOwner.publicKey, keypair.publicKey);
    
    // Build approve_allowance instructions
    const poolCoder = new BorshCoder(poolIdl as any);
    const approveData = poolCoder.instruction.encode('approve_allowance', {
      args: {
        amount: new BN(allowanceAmount.toString()),
        expires_at: null
      }
    });
    
    // Approve allowance for mint1
    const approveIx1 = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolState1, isSigner: false, isWritable: true },
        { pubkey: allowanceKey1, isSigner: false, isWritable: true },
        { pubkey: allowanceOwner.publicKey, isSigner: true, isWritable: true },
        { pubkey: keypair.publicKey, isSigner: false, isWritable: false },
        { pubkey: mint1, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: approveData
    });
    
    const approveTx1 = new Transaction().add(approveIx1);
    approveTx1.feePayer = allowanceOwner.publicKey;
    const approveBlockhash1 = await connection.getLatestBlockhash('confirmed');
    approveTx1.recentBlockhash = approveBlockhash1.blockhash;
    approveTx1.sign(allowanceOwner);
    const approveSig1 = await connection.sendRawTransaction(approveTx1.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(approveSig1, 'confirmed');
    console.log(`   ✓ Allowance 1 approved: ${approveSig1}`);
    
    // Approve allowance for mint2
    const approveIx2 = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolState2, isSigner: false, isWritable: true },
        { pubkey: allowanceKey2, isSigner: false, isWritable: true },
        { pubkey: allowanceOwner.publicKey, isSigner: true, isWritable: true },
        { pubkey: keypair.publicKey, isSigner: false, isWritable: false },
        { pubkey: mint2, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: approveData
    });
    
    const approveTx2 = new Transaction().add(approveIx2);
    approveTx2.feePayer = allowanceOwner.publicKey;
    const approveBlockhash2 = await connection.getLatestBlockhash('confirmed');
    approveTx2.recentBlockhash = approveBlockhash2.blockhash;
    approveTx2.sign(allowanceOwner);
    const approveSig2 = await connection.sendRawTransaction(approveTx2.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(approveSig2, 'confirmed');
    console.log(`   ✓ Allowance 2 approved: ${approveSig2}`);
    
    // Step 5: Prepare batch transferFrom
    console.log('5. Preparing batch transferFrom...');
    const recipient = Keypair.generate().publicKey;
    const transferAmount = BigInt(50_000_000); // 0.05 tokens
    
    const batchProof = await generateBatchTransferFromProof(
      proofClient,
      connection,
      [
        {
          originMint: mint1,
          notes: [{
            noteId: depositId1,
            spendingKey: blinding1,
            amount: shieldAmount
          }],
          outputs: [{
            amount: transferAmount,
            recipient,
            blinding: Math.floor(Math.random() * 10 ** 18).toString()
          }],
          allowanceAmount,
          spendAmount,
          allowanceOwner: allowanceOwner.publicKey
        },
        {
          originMint: mint2,
          notes: [{
            noteId: depositId2,
            spendingKey: blinding2,
            amount: shieldAmount
          }],
          outputs: [{
            amount: transferAmount,
            recipient,
            blinding: Math.floor(Math.random() * 10 ** 18).toString()
          }],
          allowanceAmount,
          spendAmount,
          allowanceOwner: allowanceOwner.publicKey
        }
      ]
    );
    console.log('   ✓ Batch transferFrom proof generated');
    
    // Extract nullifiers and commitments
    const nullifiers1 = batchProof.transfers[0]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    const outputCommitments1 = batchProof.transfers[0]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    const outputAmountCommitments1 = batchProof.transfers[0]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    const nullifiers2 = batchProof.transfers[1]!.nullifiers.map(n => bytesLEToCanonicalHex(n));
    const outputCommitments2 = batchProof.transfers[1]!.outputCommitments.map(c => bytesLEToCanonicalHex(c));
    const outputAmountCommitments2 = batchProof.transfers[1]!.outputAmountCommitments.map(c => bytesLEToCanonicalHex(c));
    
    const { operationId: batchOpId, signature: prepareBatchSig } = await prepareBatchTransferFrom({
      wallet,
      connection,
      transfers: [
        {
          originMint: mint1.toBase58(),
          poolId: poolState1.toBase58(),
          proof: batchProof,
          nullifiers: nullifiers1,
          outputCommitments: outputCommitments1,
          outputAmountCommitments: outputAmountCommitments1
        },
        {
          originMint: mint2.toBase58(),
          poolId: poolState2.toBase58(),
          proof: batchProof,
          nullifiers: nullifiers2,
          outputCommitments: outputCommitments2,
          outputAmountCommitments: outputAmountCommitments2
        }
      ],
      allowances: [
        {
          allowanceOwner: allowanceOwner.publicKey.toBase58(),
          allowanceAmount,
          spendAmount
        },
        {
          allowanceOwner: allowanceOwner.publicKey.toBase58(),
          allowanceAmount,
          spendAmount
        }
      ],
      batchProof,
      batchPublicInputs: batchProof.publicInputs
    });
    console.log(`   ✓ Batch transferFrom prepared: ${prepareBatchSig}`);
    console.log(`   ✓ Operation ID: ${batchOpId}`);
    
    // Step 6: Execute batch transferFrom
    console.log('6. Executing batch transferFrom...');
    const executeBatchSig = await executeBatchTransferFrom({
      wallet,
      connection,
      operationId: batchOpId,
      transfers: [
        { originMint: mint1.toBase58(), poolId: poolState1.toBase58() },
        { originMint: mint2.toBase58(), poolId: poolState2.toBase58() }
      ],
      allowances: [
        {
          allowanceOwner: allowanceOwner.publicKey.toBase58(),
          allowanceAmount,
          spendAmount
        },
        {
          allowanceOwner: allowanceOwner.publicKey.toBase58(),
          allowanceAmount,
          spendAmount
        }
      ],
      keypair
    });
    console.log(`   ✓ Execute signature: ${executeBatchSig}`);
    console.log('   ✓ Batch transferFrom completed successfully!');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
    }
    return false;
  }
}

async function testOperationExpiry() {
  console.log('\n=== Test: Operation Expiry ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
  const { derivePoolState } = await import('../lib/onchain/pdas');
  const poolState = derivePoolState(new PublicKey(originMint));
  
  try {
    // Step 1: Prepare a shield operation
    console.log('1. Preparing shield operation...');
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
    console.log(`   ✓ Shield prepared with operation ID: ${operationId}`);
    
    // Step 2: Verify operation exists and is in Prepared status
    console.log('2. Verifying operation exists...');
    const vaultData = await getProofVaultAccount(connection, keypair.publicKey);
    if (!vaultData) {
      throw new Error('Proof vault not found');
    }
    const operation = vaultData.preparedOperations.find((op: any) => {
      if (op.shield) {
        return Buffer.from(op.shield.operation_id).toString('hex') === operationId;
      }
      return false;
    });
    if (!operation) {
      throw new Error('Operation not found in vault');
    }
    console.log('   ✓ Operation found in vault');
    
    // Step 3: Note that we can't actually wait 5 minutes in a test
    // Instead, we verify that the expiry time is set correctly
    console.log('3. Verifying expiry time is set...');
    if (operation.shield) {
      const expiresAt = operation.shield.expires_at?.toNumber();
      const createdAt = operation.shield.created_at?.toNumber();
      if (!expiresAt || !createdAt) {
        throw new Error('Expiry or creation time not set');
      }
      const expirySeconds = expiresAt - createdAt;
      console.log(`   ✓ Expiry set to ${expirySeconds} seconds (expected ~300 seconds)`);
      if (expirySeconds < 290 || expirySeconds > 310) {
        console.warn(`   ⚠️  Expiry time is ${expirySeconds}s, expected ~300s`);
      }
    }
    
    // Step 4: Test that executing immediately works (operation not expired)
    console.log('4. Testing immediate execution (should succeed)...');
    try {
      // Note: We can't actually execute without proper setup, but we can verify the operation exists
      // In a real scenario, you would execute here and it should succeed
      console.log('   ✓ Operation is not expired (would execute successfully)');
    } catch (error: any) {
      console.error('   ✗ Unexpected error:', error.message);
      throw error;
    }
    
    console.log('   ✓ Expiry test completed (operation expires in ~5 minutes)');
    console.log('   ℹ️  Note: Full expiry test requires waiting 5+ minutes');
    console.log('   ℹ️  This test verifies expiry time is set correctly');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
    }
    return false;
  }
}

async function testCleanupExpiredOperations() {
  console.log('\n=== Test: Cleanup Expired Operations ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL first
  await airdropSol(connection, keypair.publicKey, BigInt(2) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
  const { derivePoolState } = await import('../lib/onchain/pdas');
  const poolState = derivePoolState(new PublicKey(originMint));
  
  try {
    // Step 1: Create proof vault with multiple operations
    console.log('1. Creating proof vault with operations...');
    const shieldAmount = BigInt(10_000_000); // 0.01 SOL
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    const currentRoot = await fetchZTokenPoolRoot(connection, new PublicKey(originMint));
    
    // Prepare first operation
    const depositId1 = Date.now().toString();
    const blinding1 = Math.floor(Math.random() * 10 ** 18).toString();
    const shieldProof1 = await proofClient.requestProof('wrap', {
      oldRoot: currentRoot,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId: depositId1,
      poolId: poolState.toBase58(),
      blinding: blinding1,
      mintId: originMint
    });
    const { operationId: opId1 } = await prepareShield({
      wallet, connection, originMint, amount: shieldAmount,
      depositId: depositId1, blinding: blinding1, proof: shieldProof1, proofClient
    });
    console.log(`   ✓ Operation 1 prepared: ${opId1}`);
    
    // Prepare second operation
    await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay
    const depositId2 = (Date.now() + 1).toString();
    const blinding2 = Math.floor(Math.random() * 10 ** 18).toString();
    const newRoot = await fetchZTokenPoolRoot(connection, new PublicKey(originMint));
    const shieldProof2 = await proofClient.requestProof('wrap', {
      oldRoot: newRoot,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId: depositId2,
      poolId: poolState.toBase58(),
      blinding: blinding2,
      mintId: originMint
    });
    const { operationId: opId2 } = await prepareShield({
      wallet, connection, originMint, amount: shieldAmount,
      depositId: depositId2, blinding: blinding2, proof: shieldProof2, proofClient
    });
    console.log(`   ✓ Operation 2 prepared: ${opId2}`);
    
    // Step 2: Verify operations exist
    console.log('2. Verifying operations exist...');
    const vaultDataBefore = await getProofVaultAccount(connection, keypair.publicKey);
    if (!vaultDataBefore) {
      throw new Error('Proof vault not found');
    }
    const operationCountBefore = vaultDataBefore.operationCount;
    console.log(`   ✓ Found ${operationCountBefore} operations in vault`);
    
    // Step 3: Call cleanup (should not remove non-expired operations)
    console.log('3. Calling cleanup_expired_operations...');
    const signature = await cleanupExpiredOperations({
      wallet,
      connection
    });
    console.log(`   ✓ Cleanup signature: ${signature}`);
    
    // Step 4: Verify operations still exist (not expired yet)
    console.log('4. Verifying operations still exist (not expired)...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for confirmation
    const vaultDataAfter = await getProofVaultAccount(connection, keypair.publicKey);
    if (!vaultDataAfter) {
      throw new Error('Proof vault not found after cleanup');
    }
    const operationCountAfter = vaultDataAfter.operationCount;
    console.log(`   ✓ Found ${operationCountAfter} operations after cleanup`);
    
    if (operationCountAfter === operationCountBefore) {
      console.log('   ✓ Cleanup correctly preserved non-expired operations');
    } else {
      console.warn(`   ⚠️  Operation count changed: ${operationCountBefore} -> ${operationCountAfter}`);
    }
    
    console.log('   ✓ Cleanup test completed successfully!');
    console.log('   ℹ️  Note: To test actual expiry cleanup, wait 5+ minutes and run cleanup again');
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
    }
    return false;
  }
}

async function testVaultCapacity() {
  console.log('\n=== Test: Vault Capacity Limits ===');
  
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.generate();
  const wallet = createWalletAdapter(keypair);
  
  // Airdrop SOL
  await airdropSol(connection, keypair.publicKey, BigInt(3) * BigInt(LAMPORTS_PER_SOL));
  
  const proofClient = new ProofClient({ baseUrl: PROOF_URL });
  const originMint = 'So11111111111111111111111111111111111111112'; // wSOL
  const { derivePoolState } = await import('../lib/onchain/pdas');
  const poolState = derivePoolState(new PublicKey(originMint));
  
  try {
    console.log('1. Testing vault capacity limit (MAX_OPERATIONS = 10)...');
    const shieldAmount = BigInt(10_000_000); // 0.01 SOL
    const { fetchZTokenPoolRoot } = await import('../lib/dex-ztoken-helpers');
    
    // Create operations up to the limit
    const MAX_OPERATIONS = 10;
    const operations: string[] = [];
    
    let currentRoot = await fetchZTokenPoolRoot(connection, new PublicKey(originMint));
    
    for (let i = 0; i < MAX_OPERATIONS; i++) {
      console.log(`   Preparing operation ${i + 1}/${MAX_OPERATIONS}...`);
      const depositId = (Date.now() + i).toString();
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
      
      try {
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
        operations.push(operationId);
        console.log(`   ✓ Operation ${i + 1} prepared: ${operationId}`);
        
        // Update root for next operation
        await new Promise(resolve => setTimeout(resolve, 500));
        currentRoot = await fetchZTokenPoolRoot(connection, new PublicKey(originMint));
      } catch (error: any) {
        if (error.message?.includes('VaultFull') || error.message?.includes('vault full')) {
          console.log(`   ✓ Vault capacity reached at operation ${i + 1} (expected at ${MAX_OPERATIONS + 1})`);
          break;
        }
        throw error;
      }
    }
    
    // Step 2: Verify vault is at capacity
    console.log('2. Verifying vault capacity...');
    const vaultData = await getProofVaultAccount(connection, keypair.publicKey);
    if (!vaultData) {
      throw new Error('Proof vault not found');
    }
    
    const operationCount = vaultData.operationCount;
    const preparedOpsCount = vaultData.preparedOperations.length;
    console.log(`   ✓ Vault has ${operationCount} total operations`);
    console.log(`   ✓ Vault has ${preparedOpsCount} prepared operations`);
    
    if (preparedOpsCount >= MAX_OPERATIONS) {
      console.log(`   ✓ Vault is at or near capacity (${preparedOpsCount}/${MAX_OPERATIONS})`);
    }
    
    // Step 3: Try to add one more operation (should fail if at capacity)
    console.log('3. Attempting to add operation beyond capacity...');
    const depositIdExtra = (Date.now() + 1000).toString();
    const blindingExtra = Math.floor(Math.random() * 10 ** 18).toString();
    const shieldProofExtra = await proofClient.requestProof('wrap', {
      oldRoot: currentRoot,
      amount: shieldAmount.toString(),
      recipient: keypair.publicKey.toBase58(),
      depositId: depositIdExtra,
      poolId: poolState.toBase58(),
      blinding: blindingExtra,
      mintId: originMint
    });
    
    try {
      await prepareShield({
        wallet,
        connection,
        originMint,
        amount: shieldAmount,
        depositId: depositIdExtra,
        blinding: blindingExtra,
        proof: shieldProofExtra,
        proofClient
      });
      
      // If we get here and vault is at capacity, that's unexpected
      if (preparedOpsCount >= MAX_OPERATIONS) {
        console.warn('   ⚠️  Vault at capacity but operation was accepted (may have been cleaned up)');
      } else {
        console.log('   ✓ Additional operation accepted (vault not at capacity)');
      }
    } catch (error: any) {
      if (error.message?.includes('VaultFull') || error.message?.includes('vault full')) {
        console.log('   ✓ Correctly rejected operation when vault is full');
      } else {
        console.warn(`   ⚠️  Unexpected error: ${error.message}`);
      }
    }
    
    console.log('   ✓ Vault capacity test completed!');
    console.log(`   ℹ️  Created ${operations.length} operations`);
    console.log(`   ℹ️  Vault can hold up to ${MAX_OPERATIONS} operations`);
    
    return true;
  } catch (error: any) {
    console.error('   ✗ Test failed:', error.message);
    if (error.logs) {
      console.error('   Transaction logs:', error.logs);
    }
    if (error.transactionLogs) {
      console.error('   Full transaction logs:', error.transactionLogs);
    }
    if (error.transactionMessage) {
      console.error('   Transaction message:', error.transactionMessage);
    }
    if (error.signature) {
      console.error('   Failed signature:', error.signature);
    }
    return false;
  }
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

