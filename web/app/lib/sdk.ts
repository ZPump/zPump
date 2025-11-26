import { Buffer } from 'buffer';
import { createHash } from 'crypto';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from '@solana/web3.js';
import { WalletContextState } from '@solana/wallet-adapter-react';
import { BorshCoder, BN, Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  POOL_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  FACTORY_PROGRAM_ID
} from './onchain/programIds';
import {
  deriveAllowanceAccount,
  deriveCommitmentTree,
  deriveHookConfig,
  deriveHookWhitelist,
  deriveNullifierSet,
  deriveNoteLedger,
  deriveVaultState,
  deriveVerifyingKey,
  deriveMintMapping,
  deriveFactoryState,
  deriveFactoryConfig,
  deriveShieldClaim,
  deriveTokenMetadata,
  derivePoolState
} from './onchain/pdas';
import { decodeCommitmentTree } from './onchain/commitmentTree';
import {
  bytesToBigIntLE,
  canonicalHexToBytesLE,
  bytesLEToCanonicalHex,
  canonicalizeHex
} from './onchain/utils';
import { poseidonHashMany } from './onchain/poseidon';
import { ProofResponse, ProofClient } from './proofClient';
import poolIdl from '../idl/ptf_pool.json';
import factoryIdl from '../idl/ptf_factory.json';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createApproveInstruction,
  createRevokeInstruction
} from '@solana/spl-token';

const DEFAULT_SIGNATURE_TIMEOUT_MS = 60_000;
const SIGNATURE_POLL_INTERVAL_MS = 500;

const poolCoder = new BorshCoder(poolIdl as Idl);
const factoryCoder = new BorshCoder(factoryIdl as Idl);

export const MINT_STATUS = {
  UNKNOWN: 0,
  ACTIVE: 1,
  FROZEN: 2
} as const;

const SHIELD_CLAIM_STATUS = {
  INACTIVE: 0,
  PENDING_TREE: 1,
  AWAITING_LEDGER: 2,
  AWAITING_INVARIANT: 3
} as const;

type ShieldClaimAccount = {
  status: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pubkeyToFieldBytes(key: PublicKey): number[] {
  const bytes = Array.from(key.toBytes());
  bytes.reverse();
  return bytes;
}

async function waitForSignatureConfirmation(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  timeoutMs: number = DEFAULT_SIGNATURE_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const statusResponse = await connection.getSignatureStatuses([signature]);
    const status = statusResponse.value[0];
    if (status?.err) {
      throw new Error(`Signature ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Signature ${signature} timed out after ${timeoutMs}ms`);
    }
    const currentBlockHeight = await connection.getBlockHeight('confirmed');
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error(`Signature ${signature} expired before confirmation (blockhash ${blockhash})`);
    }
    await sleep(SIGNATURE_POLL_INTERVAL_MS);
  }
}

interface BaseParams {
  connection: Connection;
  wallet: WalletContextState;
  originMint: string;
  amount: bigint;
  poolId: string;
}

interface WrapParams extends BaseParams {
  depositId: string;
  blinding: string;
  proof: ProofResponse | null;
  commitmentHint?: string | null;
  recipient?: string;
  twinMint?: string | null;
  lookupTable?: string;
}

interface UnwrapParams extends BaseParams {
  destination: string;
  mode: 'origin' | 'ztkn' | 'ptkn';
  proof: ProofResponse;
  lookupTable?: string;
  twinMint?: string;
}

interface TransferParams {
  connection: Connection;
  wallet: WalletContextState;
  originMint: string;
  poolId: string;
  proof: ProofResponse;
  nullifiers: readonly string[];
  outputCommitments: readonly string[];
  outputAmountCommitments: readonly string[];
  lookupTable?: string;
}

interface TransferFromParams extends TransferParams {
  allowanceOwner: string;
  allowanceAmount: bigint | number | string;
  // CRITICAL FIX: Actual spend amount (sum of outputs to others, excluding change back to spender)
  // This must match allowanceAmount to prevent bypass attacks
  spendAmount: bigint | number | string;
}

interface MintNativeZTokenParams {
  connection: Connection;
  wallet: WalletContextState;
  name: string;
  symbol: string;
  uri: string; // IPFS URI (e.g., "ipfs://Qm...")
  decimals: number;
  initialSupply: bigint | number | string;
  featureFlags?: number;
  feeBpsOverride?: number;
}

export interface MintNativeZTokenResult {
  signature: string;
  originMint: string;
  poolId: string;
  metadataAccount: string;
  mintMapping: string;
  decimals: number;
  symbol: string;
  uri: string;
}

type SplTokenProgramKind = 'token' | 'token-2022';

interface ApproveSplTokenParams {
  connection: Connection;
  wallet: WalletContextState;
  mint: string;
  delegate: string;
  amount: bigint | number | string;
  ownerTokenAccount?: string;
  program?: SplTokenProgramKind;
}

interface RevokeSplTokenParams {
  connection: Connection;
  wallet: WalletContextState;
  mint: string;
  ownerTokenAccount?: string;
  program?: SplTokenProgramKind;
}

interface DecodedProofPayload {
  proof: Buffer;
  publicInputs: Buffer;
  fields: Uint8Array[];
}

function toFixedArray(value: Uint8Array, label: string): number[] {
  if (value.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return Array.from(value);
}

function encodeFieldElementHex(value: string, label: string): number[] {
  const canonical = canonicalizeHex(value);
  const bytes = canonicalHexToBytesLE(canonical, 32);
  return Array.from(bytes);
}

function encodeFieldVector(values: readonly string[], label: string): number[][] {
  return values.map((entry, index) => encodeFieldElementHex(entry, `${label}[${index}]`));
}

function resolveSplProgram(kind: SplTokenProgramKind = 'token'): PublicKey {
  return kind === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

function decodeProofPayload(payload: ProofResponse | null): DecodedProofPayload {
  if (!payload) {
    return {
      proof: Buffer.alloc(0),
      publicInputs: Buffer.alloc(0),
      fields: []
    };
  }

  if (typeof payload.proof !== 'string') {
    throw new Error('Proof payload missing base64 proof data');
  }
  const proofBytes = Buffer.from(payload.proof, 'base64');

  const fieldBytes = payload.publicInputs.map((input, index) => {
    if (typeof input !== 'string') {
      throw new Error(`Public input at index ${index} is not a string`);
    }
    const canonical = canonicalizeHex(input);
    const bytes = canonicalHexToBytesLE(canonical, 32);
    if (bytes.length !== 32) {
      throw new Error(`Public input at index ${index} must be 32 bytes`);
    }
    return bytes;
  });

  const flattened = Buffer.concat(fieldBytes.map((entry) => Buffer.from(entry)));
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[decodeProofPayload] publicInputs', {
      count: fieldBytes.length,
      fieldLengths: fieldBytes.map((entry) => entry.length),
      flattenedLength: flattened.length
    });
  }

  return {
    proof: proofBytes,
    publicInputs: flattened,
    fields: fieldBytes
  };
}

export interface MintMappingAccount {
  originMint: PublicKey;
  ptknMint: PublicKey;
  hasPtkn: boolean;
  status: number;
  decimals: number;
  features: number;
  feeBpsOverride: number;
  hasFeeOverride: boolean;
  bump: number;
  isNativeZtoken: boolean;
  lookupTable?: PublicKey | null;
}

export async function fetchMintMappingAccount(
  connection: Connection,
  originMint: PublicKey
): Promise<{ key: PublicKey; decoded: MintMappingAccount }> {
  const key = deriveMintMapping(originMint);
  const account = await connection.getAccountInfo(key, 'confirmed');
  if (!account) {
    throw new Error('Mint mapping account missing on chain');
  }
  
  // Handle backward compatibility: old accounts are 85 bytes, new are 118 bytes
  // If account is old size, lookup_table will be undefined
  const decoded = factoryCoder.accounts.decode('MintMapping', account.data) as any;
  
  // Normalize field names (Anchor uses snake_case, we use camelCase)
  const normalized: MintMappingAccount = {
    originMint: new PublicKey(decoded.originMint || decoded.origin_mint),
    ptknMint: new PublicKey(decoded.ptknMint || decoded.ptkn_mint),
    hasPtkn: decoded.hasPtkn ?? decoded.has_ptkn ?? false,
    status: decoded.status ?? 0,
    decimals: decoded.decimals ?? 0,
    features: decoded.features ?? 0,
    feeBpsOverride: decoded.feeBpsOverride ?? decoded.fee_bps_override ?? 0,
    hasFeeOverride: decoded.hasFeeOverride ?? decoded.has_fee_override ?? false,
    bump: decoded.bump ?? 0,
    isNativeZtoken: decoded.isNativeZtoken ?? decoded.is_native_ztoken ?? false,
    lookupTable: decoded.lookupTable || decoded.lookup_table 
      ? new PublicKey(decoded.lookupTable || decoded.lookup_table)
      : null
  };
  
  return { key, decoded: normalized };
}

function ensureMintActive(mapping: { status?: number }): void {
  if (mapping.status !== MINT_STATUS.ACTIVE) {
    const label =
      mapping.status === MINT_STATUS.FROZEN
        ? 'frozen by governance'
        : 'inactive or unregistered';
    throw new Error(`Mint is currently ${label}. Please select a supported asset or wait until it is thawed.`);
  }
}

async function fetchShieldClaimState(
  connection: Connection,
  address: PublicKey
): Promise<ShieldClaimAccount> {
  const accountInfo = await connection.getAccountInfo(address, 'confirmed');
  if (!accountInfo) {
    throw new Error('Shield claim account missing on chain');
  }
  return poolCoder.accounts.decode('ShieldClaim', accountInfo.data) as ShieldClaimAccount;
}

function assertWallet(wallet: WalletContextState): asserts wallet is WalletContextState & {
  publicKey: NonNullable<WalletContextState['publicKey']>;
  sendTransaction: NonNullable<WalletContextState['sendTransaction']>;
} {
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error('Wallet not connected');
  }
}

function extractCommitmentByteOutputs(publicInputs: Buffer): Uint8Array | null {
  if (publicInputs.length % 32 !== 0) {
    return null;
  }
  const fieldCount = publicInputs.length / 32;
  if (fieldCount < 35) {
    return null;
  }
  const bytes = new Uint8Array(32);
  const start = publicInputs.length - 32 * 32;
  if (start < 0) {
    return null;
  }
  for (let idx = 0; idx < 32; idx += 1) {
    const field = publicInputs.subarray(start + idx * 32, start + (idx + 1) * 32);
    bytes[idx] = field[0] ?? 0;
  }
  return bytes;
}

async function waitForPendingShieldInactive(
  connection: Connection,
  poolStateKey: PublicKey,
  timeoutMs: number = 60_000
): Promise<void> {
  const start = Date.now();
  let attempts = 0;
  const maxAttempts = Math.ceil(timeoutMs / 1000);
  
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const accountInfo = await connection.getAccountInfo(poolStateKey, 'confirmed');
    if (!accountInfo) {
      throw new Error('Pool state account missing');
    }
    
    try {
      // Try decoding first
      const decoded = poolCoder.accounts.decode('PoolState', accountInfo.data) as {
        pendingShield?: { active?: number };
        pending_shield?: { active?: number };
      };
      const pendingShield = decoded.pendingShield ?? decoded.pending_shield;
      const isActive = pendingShield?.active !== undefined && pendingShield.active !== 0;
      
      if (!isActive) {
        if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
          console.info(`[wrap] pending_shield is inactive after ${attempts} attempts`);
        }
        return;
      }
      
      if (attempts % 10 === 0) {
        console.info(`[wrap] Waiting for pending_shield to be inactive (attempt ${attempts}/${maxAttempts})...`);
      }
    } catch (error) {
      // If decoding fails, we can't reliably check pending_shield status
      // Skip the check and let the program reject with PendingShieldInFlight if it's active
      // We'll handle that error below
      if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
        console.warn('[wrap] Failed to decode PoolState, skipping pending_shield check:', error);
      }
      return; // Proceed and let program handle it
    }
    
    await sleep(1000);
  }
  
  throw new Error(`pending_shield did not become inactive within ${timeoutMs}ms`);
}


/**
 * Creates a lookup table with factory state as authority and stores it in MintMapping
 */
async function ensureLookupTableForMint(
  connection: Connection,
  wallet: WalletContextState,
  factoryState: PublicKey,
  originMint: PublicKey,
  addresses: PublicKey[]
): Promise<PublicKey> {
  // Remove duplicates and ensure factory state is included
  const uniqueAddresses = Array.from(new Set(addresses.map(a => a.toBase58()))).map(a => new PublicKey(a));
  if (!uniqueAddresses.some(a => a.equals(factoryState))) {
    uniqueAddresses.push(factoryState);
  }

  // Create lookup table with wallet as authority (to avoid PDA signing issues)
  // Note: The Rust program doesn't validate lookup table authority matches factory state
  // Get current slot and blockhash right before creating instruction to minimize staleness
  const recentSlot = await connection.getSlot('confirmed');
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey!,
    payer: wallet.publicKey!,
    recentSlot
  });

  // Get fresh blockhash right before sending to minimize staleness
  const createBlockhash = await connection.getLatestBlockhash('confirmed');
  const createTx = new Transaction();
  createTx.feePayer = wallet.publicKey!;
  createTx.recentBlockhash = createBlockhash.blockhash;
  createTx.add(createIx);

  // Use skipPreflight: true to avoid simulation issues with slot staleness
  // Similar to how lowlevel-e2e handles lookup table creation
  const createSignature = await wallet.sendTransaction(createTx, connection, {
    skipPreflight: true
  });
  await waitForSignatureConfirmation(
    connection,
    createSignature,
    createBlockhash.blockhash,
    createBlockhash.lastValidBlockHeight
  );

  const creationSlot = recentSlot;

  // Extend lookup table with addresses (in chunks of 20)
  const CHUNK_SIZE = 20;
  for (let i = 0; i < uniqueAddresses.length; i += CHUNK_SIZE) {
    const chunk = uniqueAddresses.slice(i, i + CHUNK_SIZE);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      authority: wallet.publicKey!,
      payer: wallet.publicKey!,
      lookupTable: lookupTableAddress,
      addresses: chunk
    });

    // Get fresh blockhash right before sending
    const extendBlockhash = await connection.getLatestBlockhash('confirmed');
    const extendTx = new Transaction();
    extendTx.feePayer = wallet.publicKey!;
    extendTx.recentBlockhash = extendBlockhash.blockhash;
    extendTx.add(extendIx);
    
    // Use skipPreflight: true to avoid simulation issues
    const extendSignature = await wallet.sendTransaction(extendTx, connection, {
      skipPreflight: true
    });
    await waitForSignatureConfirmation(
      connection,
      extendSignature,
      extendBlockhash.blockhash,
      extendBlockhash.lastValidBlockHeight
    );
  }

  // Wait for lookup table to be activated
  let activated = false;
  let attempts = 0;
  const maxAttempts = 120; // 60 seconds max (increase for devnet)

  console.info(`[ensureLookupTableForMint] Created lookup table at slot ${creationSlot}, waiting for activation...`);
  
  while (!activated && attempts < maxAttempts) {
    await sleep(500);
    attempts++;
    
    try {
      const currentSlot = await connection.getSlot('confirmed');
      const tableResponse = await connection.getAddressLookupTable(lookupTableAddress);
      
      if (tableResponse.value && tableResponse.value.state) {
        const deactivationSlot = tableResponse.value.state.deactivationSlot;
        const U64_MAX = BigInt('18446744073709551615'); // u64::MAX
        // Lookup table is active when deactivationSlot is null OR u64::MAX (18446744073709551615)
        const isActive = deactivationSlot === null || 
                         (typeof deactivationSlot === 'bigint' && deactivationSlot === U64_MAX) ||
                         (typeof deactivationSlot === 'number' && deactivationSlot === Number(U64_MAX)) ||
                         (typeof deactivationSlot === 'string' && BigInt(deactivationSlot) === U64_MAX);
        
        if (currentSlot >= creationSlot + 1 && isActive) {
          activated = true;
          console.info(`[ensureLookupTableForMint] Lookup table activated at slot ${currentSlot}`);
        } else if (attempts % 10 === 0) {
          console.info(`[ensureLookupTableForMint] Waiting for activation... current slot: ${currentSlot}, need: ${creationSlot + 1}, deactivationSlot: ${deactivationSlot}, isActive: ${isActive}`);
        }
      }
    } catch (error) {
      if (attempts % 10 === 0) {
        console.info(`[ensureLookupTableForMint] Waiting for lookup table to be available (attempt ${attempts}/${maxAttempts})...`);
      }
    }
  }

  if (!activated) {
    throw new Error(`Lookup table not activated within ${maxAttempts * 0.5} seconds`);
  }
  
  // Additional wait to ensure account data has propagated (similar to lowlevel-e2e)
  const currentSlotAfterActivation = await connection.getSlot('confirmed');
  const slotsNeeded = Math.max(0, (creationSlot + 1) - currentSlotAfterActivation);
  if (slotsNeeded > 0) {
    console.info(`[ensureLookupTableForMint] Waiting for ${slotsNeeded} more slots to pass...`);
    await sleep(Math.max(2000, slotsNeeded * 500));
  } else {
    console.info(`[ensureLookupTableForMint] Waiting additional 5 seconds for account data propagation...`);
    await sleep(5000); // Increase wait time
  }
  
  // Verify lookup table is accessible and has proper data before storing
  let verifyAttempts = 0;
  const maxVerifyAttempts = 20;
  while (verifyAttempts < maxVerifyAttempts) {
    const verifyResponse = await connection.getAddressLookupTable(lookupTableAddress);
    if (verifyResponse.value && verifyResponse.value.state) {
      // Check that account data is large enough (at least LOOKUP_TABLE_META_SIZE = 56 bytes)
      const accountInfo = await connection.getAccountInfo(lookupTableAddress);
      if (accountInfo && accountInfo.data.length >= 56) {
        console.info(`[ensureLookupTableForMint] Lookup table verified accessible with ${accountInfo.data.length} bytes before storing in MintMapping`);
        break;
      }
    }
    verifyAttempts++;
    if (verifyAttempts < maxVerifyAttempts) {
      await sleep(500);
    } else {
      throw new Error('Lookup table account data not accessible after activation wait');
    }
  }

  // Store lookup table in MintMapping
  await setLookupTableForMint(connection, wallet, originMint, lookupTableAddress);

  return lookupTableAddress;
}

/**
 * Sets the lookup table address in MintMapping via set_lookup_table instruction
 */
export async function setLookupTableForMint(
  connection: Connection,
  wallet: WalletContextState,
  originMint: PublicKey,
  lookupTable: PublicKey
): Promise<string> {
  const factoryState = deriveFactoryState();
  const mintMapping = deriveMintMapping(originMint);

  const setLookupTableData = factoryCoder.instruction.encode('set_lookup_table', {});
  // Account order must match Rust program's SetLookupTable struct:
  // 1. factory_state (mut)
  // 2. authority (signer)
  // 3. mint_mapping (mut)
  // 4. origin_mint
  // 5. lookup_table
  // 6. system_program
  const setLookupTableInstruction = new TransactionInstruction({
    programId: FACTORY_PROGRAM_ID,
    keys: [
      { pubkey: factoryState, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey!, isSigner: true, isWritable: false }, // authority doesn't need to be writable
      { pubkey: mintMapping, isSigner: false, isWritable: true },
      { pubkey: originMint, isSigner: false, isWritable: false },
      { pubkey: lookupTable, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: setLookupTableData
  });

  const blockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction().add(setLookupTableInstruction);
  transaction.feePayer = wallet.publicKey!;
  transaction.recentBlockhash = blockhash.blockhash;

  // Use skipPreflight: true for set_lookup_table to avoid simulation issues
  // Similar to how lowlevel-e2e handles this
  const signature = await wallet.sendTransaction(transaction, connection, {
    skipPreflight: true
  });

  await waitForSignatureConfirmation(
    connection,
    signature,
    blockhash.blockhash,
    blockhash.lastValidBlockHeight
  );

  return signature;
}

export async function wrap(params: WrapParams): Promise<string> {
  assertWallet(params.wallet);

  const wallet = params.wallet;
  const connection = params.connection;

  const originMintKey = new PublicKey(params.originMint);
  const poolState = new PublicKey(params.poolId);
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const nullifierSet = deriveNullifierSet(originMintKey);
  const noteLedger = deriveNoteLedger(originMintKey);
  const hookConfig = deriveHookConfig(originMintKey);
  const hookWhitelist = deriveHookWhitelist(originMintKey);
  const vaultState = deriveVaultState(originMintKey);
  const verifyingKey = deriveVerifyingKey();
  const shieldClaim = deriveShieldClaim(poolState);
  const twinMintKey = params.twinMint ? new PublicKey(params.twinMint) : null;
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    originMintKey
  );
  ensureMintActive(mintMapping);
  
  // Wait for pending_shield to be inactive before starting a new shield
  // This prevents PendingShieldInFlight errors from previous incomplete operations
  // If pending_shield is stuck active, try to clear it by calling shield_finalize_tree
  // Note: We skip the check if decoding fails, as the program will reject with PendingShieldInFlight anyway
  try {
    await waitForPendingShieldInactive(connection, poolState, 3000); // Short timeout first
  } catch (error) {
    // If we can't determine pending_shield status or it's still active, try to proceed anyway
    // The program will reject with PendingShieldInFlight if it's active, which we'll handle below
    if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
      console.warn('[wrap] Could not verify pending_shield status, proceeding (program will reject if active)');
    }
    // If pending_shield is still active, try to clear it by calling shield_finalize_tree
    // This handles the case where a previous shield operation didn't complete
    console.warn('[wrap] pending_shield is still active, attempting to clear it...');
    
    let claimState: ShieldClaimAccount | null = null;
    try {
      claimState = await fetchShieldClaimState(connection, shieldClaim);
    } catch (error) {
      // Shield claim doesn't exist - this is a stuck state where pending_shield is active
      // but there's no shield claim to finalize. We can't clear it from the SDK.
      console.warn('[wrap] Shield claim does not exist but pending_shield is active - stuck state');
      // Wait a bit longer hoping it clears
      try {
        await waitForPendingShieldInactive(connection, poolState, 30000);
      } catch (waitError) {
        throw new Error('pending_shield is stuck active with no shield claim - cannot proceed. This indicates a program bug or incomplete previous operation.');
      }
    }
    
    // If shield claim exists and is in a state that allows finalize_tree, try to finalize it
    if (claimState && claimState.status !== 0) {
      try {
        const finalizeTreeData = poolCoder.instruction.encode('shield_finalize_tree', {});
        const finalizeTreeInstruction = new TransactionInstruction({
          programId: POOL_PROGRAM_ID,
          keys: [
            { pubkey: poolState, isSigner: false, isWritable: true },
            { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
            { pubkey: shieldClaim, isSigner: false, isWritable: true }
          ],
          data: finalizeTreeData
        });
        
        const clearBlockhash = await connection.getLatestBlockhash('confirmed');
        const clearTransaction = new Transaction().add(finalizeTreeInstruction);
        clearTransaction.feePayer = wallet.publicKey;
        clearTransaction.recentBlockhash = clearBlockhash.blockhash;
        
        try {
          const clearSignature = await wallet.sendTransaction(clearTransaction, connection, {
            skipPreflight: false
          });
          await waitForSignatureConfirmation(
            connection,
            clearSignature,
            clearBlockhash.blockhash,
            clearBlockhash.lastValidBlockHeight
          );
          console.info('[wrap] Cleared pending_shield via shield_finalize_tree');
          // Wait a bit more to ensure it's cleared
          await sleep(1000);
        } catch (clearError) {
          console.warn('[wrap] Failed to clear pending_shield, will retry waiting:', clearError);
          // Retry waiting with longer timeout
          await waitForPendingShieldInactive(connection, poolState, 30000);
        }
      } catch (instructionError) {
        console.warn('[wrap] Failed to create clear instruction, will retry waiting:', instructionError);
        // Retry waiting with longer timeout
        await waitForPendingShieldInactive(connection, poolState, 30000);
      }
    } else {
      // Shield claim is inactive but pending_shield is active - this is a stuck state
      // Retry waiting with longer timeout, hoping it clears somehow
      console.warn('[wrap] Shield claim is inactive but pending_shield is active - stuck state');
      await waitForPendingShieldInactive(connection, poolState, 30000);
    }
  }

  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey);
  if (!commitmentTreeAccount) {
    throw new Error('Commitment tree account missing on devnet');
  }

  const treeState = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
  const recipientKey = params.recipient ? new PublicKey(params.recipient) : wallet.publicKey;
  const depositId = BigInt(params.depositId);
  const blinding = BigInt(params.blinding);
  const amount = params.amount;

  const amountCommitmentBytes = await poseidonHashMany([amount, blinding]);

  const vaultTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    vaultState,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const depositorTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const instructions: TransactionInstruction[] = [];
  const computeLimitEnv =
    process.env.WRAP_COMPUTE_UNIT_LIMIT ?? process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT;
  const resolvedComputeLimit = (() => {
    if (computeLimitEnv !== undefined) {
      const parsed = Number(computeLimitEnv);
      if (!Number.isNaN(parsed)) {
        return Math.max(parsed, 0);
      }
    }
    return 1_400_000;
  })();

  if (resolvedComputeLimit > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedComputeLimit }));
  }

  const computePriceEnv =
    process.env.WRAP_COMPUTE_UNIT_PRICE ?? process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE;
  if (computePriceEnv) {
    const microLamports = Number(computePriceEnv);
    if (!Number.isNaN(microLamports) && microLamports > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }
  }

  const depositorInfo = await connection.getAccountInfo(depositorTokenAccount);
  if (!depositorInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        depositorTokenAccount,
        wallet.publicKey,
        originMintKey,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const decodedProof = decodeProofPayload(params.proof);
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[wrap] current root', Buffer.from(treeState.currentRoot).toString('hex'));
    // eslint-disable-next-line no-console
    console.info('[wrap] old root field', Buffer.from(decodedProof.fields[0] ?? []).toString('hex'));
    if (decodedProof.fields[0]) {
      // eslint-disable-next-line no-console
      console.info('[wrap] old root field (canonical)', bytesLEToCanonicalHex(decodedProof.fields[0]));
    }
    if (decodedProof.fields[1]) {
      // eslint-disable-next-line no-console
      console.info('[wrap] new root field (canonical)', bytesLEToCanonicalHex(decodedProof.fields[1]));
    }
  }
  const shieldArgs = {
    amount_commit: Array.from(amountCommitmentBytes),
    amount: new BN(amount.toString()),
    proof: Buffer.from(decodedProof.proof),
    public_inputs: Buffer.from(decodedProof.publicInputs)
  };
  const canonicalCommitmentBytes = extractCommitmentByteOutputs(shieldArgs.public_inputs);
  const shaLeafDigest = canonicalCommitmentBytes
    ? createHash('sha256').update(canonicalCommitmentBytes).digest()
    : null;
  const shieldData = poolCoder.instruction.encode('shield', { args: shieldArgs });
  const finalizeTreeData = poolCoder.instruction.encode('shield_finalize_tree', {});
  const finalizeLedgerData = poolCoder.instruction.encode('shield_finalize_ledger', {});
  const checkInvariantData = poolCoder.instruction.encode('shield_check_invariant', {});
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[wrap] shield arg lengths', {
      poolState: poolState.toBase58(),
      commitmentTree: commitmentTreeKey.toBase58(),
      nullifierSet: nullifierSet.toBase58(),
      noteLedger: noteLedger.toBase58(),
      vaultState: vaultState.toBase58(),
      vaultTokenAccount: vaultTokenAccount.toBase58(),
      depositorTokenAccount: depositorTokenAccount.toBase58(),
      proof: decodedProof.proof.length,
      publicInputs: decodedProof.publicInputs.length,
      canonicalCommitmentBytes: canonicalCommitmentBytes
        ? Buffer.from(canonicalCommitmentBytes).toString('hex')
        : null,
      shaLeaf: shaLeafDigest ? shaLeafDigest.toString('hex') : null
    });
    // eslint-disable-next-line no-console
    console.info('[wrap] encoded data length', shieldData.length);
    try {
      const decoded = poolCoder.instruction.decode(Buffer.from(shieldData)) as
        | {
            name: string;
            data?: { args?: { amount?: BN; proof?: Uint8Array; publicInputs?: Uint8Array } };
          }
        | null;
      const decodedArgs = decoded?.name === 'shield' ? decoded?.data?.args ?? null : null;
      // eslint-disable-next-line no-console
      console.info('[wrap] decoded shield args', {
        amount: decodedArgs?.amount?.toString?.(),
        proofLen: decodedArgs?.proof?.length,
        publicInputsLen: decodedArgs?.publicInputs?.length
      });
    } catch (decodeError) {
      // eslint-disable-next-line no-console
      console.error('[wrap] failed to decode shield args', decodeError);
      throw decodeError;
    }
  }

  const shieldKeys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: hookWhitelist, isSigner: false, isWritable: true },
    { pubkey: nullifierSet, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedger, isSigner: false, isWritable: true },
    { pubkey: vaultState, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }
  ];

  if (twinMintKey) {
    shieldKeys.push({ pubkey: twinMintKey, isSigner: false, isWritable: true });
  } else {
    // Anchor treats an optional account as `None` when the slot equals the program id.
    shieldKeys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  shieldKeys.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaim, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  const shieldInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys,
    data: shieldData
  });

  // Add finalize_ledger instruction to the same transaction as shield (required for security)
  const finalizeLedgerKeys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: noteLedger, isSigner: false, isWritable: true },
    { pubkey: shieldClaim, isSigner: false, isWritable: true },
    { pubkey: hookWhitelist, isSigner: false, isWritable: false }
  ];

  const finalizeLedgerInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: finalizeLedgerKeys,
    data: finalizeLedgerData
  });

  const finalizeTreeKeys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: shieldClaim, isSigner: false, isWritable: true }
  ];

  const checkInvariantKeys = [
    { pubkey: poolState, isSigner: false, isWritable: false },
    { pubkey: noteLedger, isSigner: false, isWritable: false },
    { pubkey: shieldClaim, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true }
  ];

  if (twinMintKey) {
    checkInvariantKeys.push({ pubkey: twinMintKey, isSigner: false, isWritable: true });
  } else {
    checkInvariantKeys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  const finalizeTreeInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: finalizeTreeKeys,
    data: finalizeTreeData
  });

  const checkInvariantInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: checkInvariantKeys,
    data: checkInvariantData
  });

  // Read lookup table from MintMapping
  const lookupTables: AddressLookupTableAccount[] = [];
  let lookupTableAddress: string | undefined = params.lookupTable;
  const factoryState = deriveFactoryState();

  // Collect all addresses that will be used in the transaction
  const allAddresses: PublicKey[] = [
    poolState,
    hookConfig,
    hookWhitelist,
    nullifierSet,
    commitmentTreeKey,
    noteLedger,
    vaultState,
    vaultTokenAccount,
    depositorTokenAccount,
    VERIFIER_PROGRAM_ID,
    verifyingKey,
    shieldClaim,
    wallet.publicKey!,
    originMintKey,
    mintMappingKey,
    VAULT_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    SYSVAR_RENT_PUBKEY
  ];
  
  if (twinMintKey) {
    allAddresses.push(twinMintKey);
  }
  
  // Add any addresses from pre-instructions
  if (instructions.length > 0) {
    instructions.forEach(ix => {
      ix.keys.forEach(key => {
        if (!allAddresses.some(addr => addr.equals(key.pubkey))) {
          allAddresses.push(key.pubkey);
        }
      });
    });
  }

  // Check if lookup table is stored in MintMapping
  if (mintMapping.lookupTable) {
    try {
      const tableKey = mintMapping.lookupTable;
      const lookupResponse = await connection.getAddressLookupTable(tableKey);
      if (lookupResponse.value && lookupResponse.value.state) {
        // Verify lookup table is active
        // Handle all activation formats: null, u64::MAX, and devnet value (0xFFFFFFFF00000001)
        const deactivationSlot = lookupResponse.value.state.deactivationSlot;
        const U64_MAX = BigInt('18446744073709551615');
        const DEVNET_ACTIVE = BigInt('18446744069414584321'); // 0xFFFFFFFF00000001
        const isActive = deactivationSlot === null || 
                         (typeof deactivationSlot === 'bigint' && (deactivationSlot === U64_MAX || deactivationSlot >= DEVNET_ACTIVE)) ||
                         (typeof deactivationSlot === 'number' && (deactivationSlot === Number(U64_MAX) || deactivationSlot >= Number(DEVNET_ACTIVE))) ||
                         (typeof deactivationSlot === 'string' && (BigInt(deactivationSlot) === U64_MAX || BigInt(deactivationSlot) >= DEVNET_ACTIVE));
        
        if (isActive) {
          const tableAddresses = lookupResponse.value.state.addresses;
          const hasAllAddresses = allAddresses.every(addr => 
            tableAddresses.some(tableAddr => tableAddr.equals(addr))
          );
          
          if (hasAllAddresses) {
            // Use lookup table from MintMapping
            lookupTableAddress = tableKey.toBase58();
            lookupTables.push(lookupResponse.value);
            console.info(`[wrap] Using lookup table from MintMapping: ${lookupTableAddress}`);
          } else {
            // Lookup table exists but missing addresses - extend it
            console.info(`[wrap] Lookup table from MintMapping missing addresses, extending...`);
            const missingAddresses = allAddresses.filter(addr => 
              !tableAddresses.some(tableAddr => tableAddr.equals(addr))
            );
            
            if (missingAddresses.length > 0) {
              // Extend lookup table with missing addresses (in chunks of 20)
              const CHUNK_SIZE = 20;
              for (let i = 0; i < missingAddresses.length; i += CHUNK_SIZE) {
                const chunk = missingAddresses.slice(i, i + CHUNK_SIZE);
                const extendIx = AddressLookupTableProgram.extendLookupTable({
                  authority: factoryState,
                  payer: wallet.publicKey!,
                  lookupTable: tableKey,
                  addresses: chunk
                });

                const extendTx = new Transaction().add(extendIx);
                extendTx.feePayer = wallet.publicKey!;
                const extendBlockhash = await connection.getLatestBlockhash('confirmed');
                extendTx.recentBlockhash = extendBlockhash.blockhash;
                
                const extendSignature = await wallet.sendTransaction(extendTx, connection, {
                  skipPreflight: false
                });
                await waitForSignatureConfirmation(
                  connection,
                  extendSignature,
                  extendBlockhash.blockhash,
                  extendBlockhash.lastValidBlockHeight
                );
              }
              
              // Reload lookup table after extension
              const updatedResponse = await connection.getAddressLookupTable(tableKey);
              if (updatedResponse.value) {
                lookupTableAddress = tableKey.toBase58();
                lookupTables.push(updatedResponse.value);
                console.info(`[wrap] Extended lookup table from MintMapping: ${lookupTableAddress}`);
              }
            }
          }
        } else {
          console.warn(`[wrap] Lookup table from MintMapping is deactivated, creating new one...`);
          lookupTableAddress = undefined;
        }
      } else {
        console.warn(`[wrap] Lookup table from MintMapping not found, creating new one...`);
        lookupTableAddress = undefined;
      }
    } catch (error) {
      console.warn('[wrap] Failed to load lookup table from MintMapping:', error);
      lookupTableAddress = undefined;
    }
  }

  // If no lookup table available, create one and store in MintMapping
  if (lookupTables.length === 0) {
    console.info('[wrap] No lookup table in MintMapping, creating new one...');
    try {
      const newLookupTable = await ensureLookupTableForMint(
        connection,
        wallet,
        factoryState,
        originMintKey,
        allAddresses
      );
      lookupTableAddress = newLookupTable.toBase58();
      
      // Load the newly created lookup table
      const lookupResponse = await connection.getAddressLookupTable(newLookupTable);
      if (lookupResponse.value) {
        lookupTables.push(lookupResponse.value);
        console.info(`[wrap] Successfully created and stored lookup table in MintMapping: ${lookupTableAddress}`);
      } else {
        throw new Error('Failed to load newly created lookup table');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[wrap] Failed to create lookup table:', errorMessage);
      console.error('[wrap] Error details:', error);
      throw new Error(`Failed to create lookup table: ${errorMessage}. Transaction cannot proceed without it.`);
    }
  }

  let latestBlockhash = await connection.getLatestBlockhash('confirmed');
  // Include shield and finalize_ledger in the same transaction (required for security)
  const shieldInstructionSet = [...instructions, shieldInstruction, finalizeLedgerInstruction];

  let shieldSignature: string | undefined;
  let shieldAttempts = 0;
  const maxShieldAttempts = 5;
  
  // Retry shield if it fails with PendingShieldInFlight (0x1793 = 6035)
  while (shieldAttempts < maxShieldAttempts) {
    shieldAttempts++;
    try {
      if (lookupTables.length > 0) {
        const shieldMessage = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: shieldInstructionSet
        }).compileToV0Message(lookupTables);
        const shieldTransaction = new VersionedTransaction(shieldMessage);
        shieldSignature = await wallet.sendTransaction(shieldTransaction, connection, {
          skipPreflight: false
        });
      } else {
        const shieldTransaction = new Transaction().add(...shieldInstructionSet);
        shieldTransaction.feePayer = wallet.publicKey;
        shieldTransaction.recentBlockhash = latestBlockhash.blockhash;
        shieldSignature = await wallet.sendTransaction(shieldTransaction, connection, {
          skipPreflight: false
        });
      }
      break; // Success, exit retry loop
    } catch (error: any) {
      // Check if error is PendingShieldInFlight using standardized error handler
      const { isPendingShieldError } = require('./errorHandler');
      const isPendingShield = isPendingShieldError(error);
      
      if (isPendingShield && shieldAttempts < maxShieldAttempts) {
        console.warn(`[wrap] Shield failed with PendingShieldInFlight (attempt ${shieldAttempts}/${maxShieldAttempts}), waiting and trying to clear...`);
        // Wait a bit and try to clear pending_shield
        await sleep(2000);
        // Try to clear by calling shield_finalize_tree if shield claim exists
        try {
          const claimState = await fetchShieldClaimState(connection, shieldClaim);
          if (claimState.status !== 0) {
            const finalizeTreeData = poolCoder.instruction.encode('shield_finalize_tree', {});
            const finalizeTreeInstruction = new TransactionInstruction({
              programId: POOL_PROGRAM_ID,
              keys: [
                { pubkey: poolState, isSigner: false, isWritable: true },
                { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
                { pubkey: shieldClaim, isSigner: false, isWritable: true }
              ],
              data: finalizeTreeData
            });
            const clearBlockhash = await connection.getLatestBlockhash('confirmed');
            const clearTransaction = new Transaction().add(finalizeTreeInstruction);
            clearTransaction.feePayer = wallet.publicKey;
            clearTransaction.recentBlockhash = clearBlockhash.blockhash;
            try {
              const clearSignature = await wallet.sendTransaction(clearTransaction, connection, {
                skipPreflight: false
              });
              await waitForSignatureConfirmation(
                connection,
                clearSignature,
                clearBlockhash.blockhash,
                clearBlockhash.lastValidBlockHeight
              );
              console.info('[wrap] Cleared pending_shield via shield_finalize_tree, refreshing root and regenerating proof...');
              await sleep(1000);
              // Refresh root after clearing pending_shield - it may have changed
              const refreshedTreeAccount = await connection.getAccountInfo(commitmentTreeKey);
              if (refreshedTreeAccount) {
                const refreshedTreeState = decodeCommitmentTree(new Uint8Array(refreshedTreeAccount.data));
                // Use bytesLEToCanonicalHex to convert little-endian bytes to canonical hex format
                const newRoot = bytesLEToCanonicalHex(refreshedTreeState.currentRoot);
                // Regenerate proof with new root
                const proofClient = new ProofClient({ baseUrl: process.env.PROOF_RPC_URL ?? 'http://127.0.0.1:8788' });
                const refreshedProof = await proofClient.requestProof('wrap', {
                  oldRoot: newRoot,
                  amount: amount.toString(),
                  recipient: recipientKey.toBase58(),
                  depositId: depositId.toString(),
                  poolId: poolState.toBase58(),
                  blinding: blinding.toString(),
                  mintId: originMintKey.toBase58()
                });
                // Update proof and public inputs
                const refreshedAmountCommitmentBytes = await poseidonHashMany([amount, blinding]);
                const refreshedDecodedProof = decodeProofPayload(refreshedProof);
                const refreshedShieldArgs = {
                  amount_commit: Array.from(refreshedAmountCommitmentBytes),
                  amount: new BN(amount.toString()),
                  proof: Buffer.from(refreshedDecodedProof.proof),
                  public_inputs: Buffer.from(refreshedDecodedProof.publicInputs)
                };
                const refreshedShieldData = poolCoder.instruction.encode('shield', { args: refreshedShieldArgs });
                // Update shield instruction with new data
                shieldInstruction.data = refreshedShieldData;
                shieldInstructionSet[shieldInstructionSet.length - 2] = shieldInstruction; // Update shield instruction (second to last, before finalize_ledger)
                console.info('[wrap] Regenerated proof with new root, retrying shield...');
              }
              await sleep(1000); // Wait for state to settle
            } catch (clearError: any) {
              // shield_finalize_tree may fail if the shield claim doesn't match current state
              // This is expected if the shield claim is stale - just wait and retry
              const isRootMismatch = clearError?.logs?.some((log: string) => log.includes('0x1792') || log.includes('RootMismatch')) ||
                                    clearError?.transactionLogs?.some((log: string) => log.includes('0x1792') || log.includes('RootMismatch'));
              if (isRootMismatch) {
                console.warn('[wrap] shield_finalize_tree failed with RootMismatch (stale shield claim), waiting longer...');
                await sleep(3000);
              } else {
                console.warn('[wrap] Failed to clear pending_shield:', clearError);
                await sleep(2000);
              }
            }
          }
        } catch (claimError) {
          // Shield claim doesn't exist or can't be read - just wait longer
          console.warn('[wrap] Could not read shield claim, waiting longer...');
          await sleep(3000);
        }
        // Refresh blockhash for retry
        latestBlockhash = await connection.getLatestBlockhash('confirmed');
        continue; // Retry shield
      } else {
        // Not PendingShieldInFlight or max attempts reached - throw the error
        throw error;
      }
    }
  }
  
  if (!shieldSignature) {
    throw new Error(`Failed to send shield transaction after ${maxShieldAttempts} attempts due to PendingShieldInFlight`);
  }

  await waitForSignatureConfirmation(
    connection,
    shieldSignature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );

  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[wrap] shield signature confirmed', shieldSignature);
  }

  const finalizeTreeInstructions: TransactionInstruction[] = [];
  if (resolvedComputeLimit > 0) {
    finalizeTreeInstructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedComputeLimit }));
  }
  finalizeTreeInstructions.push(finalizeTreeInstruction);

  let claimState = await fetchShieldClaimState(connection, shieldClaim);
  // After shield + finalize_ledger, status may be AWAITING_LEDGER, AWAITING_INVARIANT, or PENDING_TREE
  // We need to call finalize_tree for any of these statuses (except INACTIVE)
  while (claimState.status === SHIELD_CLAIM_STATUS.PENDING_TREE 
      || claimState.status === SHIELD_CLAIM_STATUS.AWAITING_LEDGER
      || claimState.status === SHIELD_CLAIM_STATUS.AWAITING_INVARIANT) {
    const treeBlockhash = await connection.getLatestBlockhash('confirmed');
    const finalizeTreeTransaction = new Transaction().add(...finalizeTreeInstructions);
    finalizeTreeTransaction.feePayer = wallet.publicKey;
    finalizeTreeTransaction.recentBlockhash = treeBlockhash.blockhash;

    const finalizeTreeSignature = await wallet.sendTransaction(finalizeTreeTransaction, connection, {
      skipPreflight: false
    });

    await waitForSignatureConfirmation(
      connection,
      finalizeTreeSignature,
      treeBlockhash.blockhash,
      treeBlockhash.lastValidBlockHeight
    );

    if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
      console.info('[wrap] shield finalize_tree signature', finalizeTreeSignature);
    }
    claimState = await fetchShieldClaimState(connection, shieldClaim);
  }

  // Wait a bit to ensure pending_shield is deactivated after shield_finalize_tree
  // This prevents race conditions where shield claim is INACTIVE but pending_shield is still active
  await sleep(500);

  // finalize_ledger is now included in the same transaction as shield (above)
  // No separate transaction needed

  const invariantInstructions: TransactionInstruction[] = [];
  if (resolvedComputeLimit > 0) {
    invariantInstructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedComputeLimit }));
  }
  invariantInstructions.push(checkInvariantInstruction);

  const invariantBlockhash = await connection.getLatestBlockhash('confirmed');
  const invariantTransaction = new Transaction().add(...invariantInstructions);
  invariantTransaction.feePayer = wallet.publicKey;
  invariantTransaction.recentBlockhash = invariantBlockhash.blockhash;

  const invariantSignature = await wallet.sendTransaction(invariantTransaction, connection, {
    skipPreflight: false
  });

  await waitForSignatureConfirmation(
    connection,
    invariantSignature,
    invariantBlockhash.blockhash,
    invariantBlockhash.lastValidBlockHeight
  );
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    console.info('[wrap] shield invariant signature', invariantSignature);
  }

  return invariantSignature;
}

export async function unwrap(params: UnwrapParams): Promise<string> {
  assertWallet(params.wallet);

  const mode = params.mode === 'ztkn' ? 'ptkn' : params.mode;
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[unwrap] params', {
      mode: params.mode,
      normalizedMode: mode,
      twinMintSupplied: Boolean(params.twinMint)
    });
  }

  const { wallet, connection } = params;
  const originMintKey = new PublicKey(params.originMint);
  const poolStateKey = new PublicKey(params.poolId);
  const destinationKey = new PublicKey(params.destination);

  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const nullifierSetKey = deriveNullifierSet(originMintKey);
  const noteLedgerKey = deriveNoteLedger(originMintKey);
  const hookConfigKey = deriveHookConfig(originMintKey);
  const hookWhitelistKey = deriveHookWhitelist(originMintKey);
  const vaultStateKey = deriveVaultState(originMintKey);
  const factoryStateKey = deriveFactoryState();
  const verifyingKey = deriveVerifyingKey();

  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey);
  if (!commitmentTreeAccount) {
    throw new Error('Commitment tree account missing on devnet');
  }

  const poolStateAccount = await connection.getAccountInfo(poolStateKey);
  if (!poolStateAccount) {
    throw new Error('Pool state account missing on devnet');
  }
  const poolStateData = Buffer.from(poolStateAccount.data);
  const CURRENT_ROOT_OFFSET = 8 + 32 * 8;
  const currentRootBytes = poolStateData.slice(CURRENT_ROOT_OFFSET, CURRENT_ROOT_OFFSET + 32);
  const poolRootCanonical = bytesLEToCanonicalHex(currentRootBytes);

  const decodedProof = decodeProofPayload(params.proof);
  const ROOT_FIELD_COUNT = 2;
  const TRAILING_FIELD_COUNT = 6;
  const CHANGE_FIELD_COUNT = 2;
  const STATIC_FIELD_COUNT = ROOT_FIELD_COUNT + TRAILING_FIELD_COUNT;
  const MIN_FIELDS = ROOT_FIELD_COUNT + 1 + CHANGE_FIELD_COUNT + TRAILING_FIELD_COUNT;

  if (decodedProof.fields.length < MIN_FIELDS) {
    throw new Error('Proof payload missing unshield public inputs');
  }

  const nullifierCount = decodedProof.fields.length - (STATIC_FIELD_COUNT + CHANGE_FIELD_COUNT);
  if (nullifierCount <= 0) {
    throw new Error('Unshield proof must contain at least one nullifier');
  }

  const oldRootBytes = decodedProof.fields[0];
  const newRootBytes = decodedProof.fields[1];
  const nullifierBytes = decodedProof.fields.slice(2, 2 + nullifierCount);
  const changeCommitmentBytes = decodedProof.fields[2 + nullifierCount];
  const changeAmountCommitmentBytes = decodedProof.fields[3 + nullifierCount];
  const amountFieldBytes = decodedProof.fields[4 + nullifierCount];
  const feeFieldBytes = decodedProof.fields[5 + nullifierCount];
  const destinationFieldBytes = decodedProof.fields[6 + nullifierCount];
  const modeFieldBytes = decodedProof.fields[7 + nullifierCount];
  const mintFieldBytes = decodedProof.fields[8 + nullifierCount];
  const poolFieldBytes = decodedProof.fields[9 + nullifierCount];

  const oldRootCanonical = bytesLEToCanonicalHex(oldRootBytes);
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[unwrap] old root bytes', {
      proof: Buffer.from(oldRootBytes).toString('hex'),
      pool: Buffer.from(currentRootBytes).toString('hex')
    });
    // eslint-disable-next-line no-console
    console.info('[unwrap] new root bytes', {
      proof: Buffer.from(newRootBytes).toString('hex')
    });
  }

  if (oldRootCanonical !== poolRootCanonical) {
    console.warn('[unwrap] root mismatch', {
      oldRootLe: Buffer.from(oldRootBytes).toString('hex'),
      currentRootLe: Buffer.from(currentRootBytes).toString('hex'),
      oldRootBe: oldRootCanonical,
      currentRootBe: poolRootCanonical
    });
    throw new Error('Commitment tree root mismatch. Refresh notes and try again.');
  }

  const vaultTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    vaultStateKey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  let twinMintKey: PublicKey | null = params.twinMint ? new PublicKey(params.twinMint) : null;
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    originMintKey
  );
  ensureMintActive(mintMapping);
  if (mintMapping.hasPtkn) {
    const candidate = new PublicKey(mintMapping.ptknMint);
    if (candidate.equals(PublicKey.default)) {
      throw new Error('Twin mint address missing from mint mapping.');
    }
    if (twinMintKey && !twinMintKey.equals(candidate)) {
      console.warn('[unwrap] twin mint mismatch', {
        provided: twinMintKey.toBase58(),
        mapping: candidate.toBase58()
      });
    }
    twinMintKey = candidate;
  }

  if (mode === 'ptkn' && !mintMapping.hasPtkn) {
    throw new Error('Twin mint is not enabled for this origin mint.');
  }

  const redeemToTwin = mode === 'ptkn';
  if (redeemToTwin && !twinMintKey) {
    throw new Error('Twin mint key missing for unwrap.');
  }

  const destinationMint = redeemToTwin ? twinMintKey! : originMintKey;
  const destinationTokenProgram = redeemToTwin ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const destinationTokenAccount = await getAssociatedTokenAddress(
    destinationMint,
    destinationKey,
    false,
    destinationTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const instructions: TransactionInstruction[] = [];

  const unwrapComputeLimitEnv =
    process.env.UNWRAP_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_UNWRAP_COMPUTE_UNIT_LIMIT ??
    process.env.WRAP_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT;
  const resolvedUnwrapLimit = (() => {
    if (unwrapComputeLimitEnv !== undefined) {
      const parsed = Number(unwrapComputeLimitEnv);
      if (!Number.isNaN(parsed)) {
        return Math.max(parsed, 0);
      }
    }
    return 1_400_000;
  })();

  if (resolvedUnwrapLimit > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedUnwrapLimit }));
  }

  const unwrapComputePriceEnv =
    process.env.UNWRAP_COMPUTE_UNIT_PRICE ??
    process.env.NEXT_PUBLIC_UNWRAP_COMPUTE_UNIT_PRICE ??
    process.env.WRAP_COMPUTE_UNIT_PRICE ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE;
  if (unwrapComputePriceEnv) {
    const microLamports = Number(unwrapComputePriceEnv);
    if (!Number.isNaN(microLamports) && microLamports > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }
  }

  const destinationInfo = await connection.getAccountInfo(destinationTokenAccount);
  if (!destinationInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        destinationTokenAccount,
        destinationKey,
        destinationMint,
        destinationTokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const poolCoder = new BorshCoder(poolIdl as Idl);

  const unshieldArgs = {
    old_root: Array.from(oldRootBytes),
    new_root: Array.from(newRootBytes),
    nullifiers: nullifierBytes.map((entry) => Array.from(entry)),
    output_commitments: [Array.from(changeCommitmentBytes)],
    output_amount_commitments: [Array.from(changeAmountCommitmentBytes)],
    amount: new BN(params.amount.toString()),
    proof: decodedProof.proof,
    public_inputs: decodedProof.publicInputs
  };

  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    const buf = (value: ArrayLike<number>) => Buffer.from(value as Uint8Array | number[]);
    const compare = (label: string, expected: Uint8Array | number[], actual: number[] | Uint8Array) => {
      const exp = buf(expected);
      const act = buf(actual);
      if (!exp.equals(act)) {
        // eslint-disable-next-line no-console
        console.warn(`[unwrap-debug] mismatch ${label}`, { expected: exp.toString('hex'), actual: act.toString('hex') });
      }
    };
    const amountBytes = new Uint8Array(32);
    new DataView(amountBytes.buffer).setBigUint64(0, BigInt(params.amount), true);
    const feeBytes = feeFieldBytes;
    const destinationExpected = pubkeyToFieldBytes(destinationKey);
    const mintExpected = pubkeyToFieldBytes(originMintKey);
    const poolExpected = pubkeyToFieldBytes(poolStateKey);
    const modeBytes = new Uint8Array(32);
    modeBytes[0] = mode === 'ptkn' ? 1 : 0;

    compare('old_root', oldRootBytes, unshieldArgs.old_root);
    compare('new_root', newRootBytes, unshieldArgs.new_root);
    nullifierBytes.forEach((value, idx) => compare(`nullifier[${idx}]`, value, unshieldArgs.nullifiers[idx]!));
    compare('change_commitment', changeCommitmentBytes, unshieldArgs.output_commitments[0]!);
    compare('change_amount_commitment', changeAmountCommitmentBytes, unshieldArgs.output_amount_commitments[0]!);
    compare('amount_bytes', amountFieldBytes, Array.from(amountBytes));
    compare('fee_bytes', feeFieldBytes, Array.from(feeBytes));
    compare('destination_bytes', destinationFieldBytes, destinationExpected);
    compare('mode_bytes', modeFieldBytes, Array.from(modeBytes));
    compare('mint_bytes', mintFieldBytes, mintExpected);
    compare('pool_bytes', poolFieldBytes, poolExpected);

    const fieldsCanonical = decodedProof.fields.map((entry) => bytesLEToCanonicalHex(entry));
    const destinationCanonical = bytesLEToCanonicalHex(buf(destinationExpected));
    const originMintCanonical = bytesLEToCanonicalHex(buf(mintExpected));
    const poolCanonical = bytesLEToCanonicalHex(buf(poolExpected));
    const expectedCanonical: string[] = [
      bytesLEToCanonicalHex(buf(unshieldArgs.old_root)),
      bytesLEToCanonicalHex(buf(unshieldArgs.new_root)),
      ...unshieldArgs.nullifiers.map((entry) => bytesLEToCanonicalHex(buf(entry))),
      ...unshieldArgs.output_commitments.map((entry) => bytesLEToCanonicalHex(buf(entry))),
      ...unshieldArgs.output_amount_commitments.map((entry) => bytesLEToCanonicalHex(buf(entry))),
      bytesLEToCanonicalHex(amountBytes),
      bytesLEToCanonicalHex(feeBytes),
      destinationCanonical,
      bytesLEToCanonicalHex(modeBytes),
      originMintCanonical,
      poolCanonical
    ];
    // eslint-disable-next-line no-console
    console.info('[unwrap-debug] fields canonical', fieldsCanonical);
    // eslint-disable-next-line no-console
    console.info('[unwrap-debug] expected canonical', expectedCanonical);
    // eslint-disable-next-line no-console
    console.info('[unwrap-debug] amount', params.amount.toString(), bytesLEToCanonicalHex(amountBytes));
  }

  const instructionName = mode === 'ptkn' ? 'unshield_to_ptkn' : 'unshield_to_origin';
  const unshieldData = poolCoder.instruction.encode(instructionName, { args: unshieldArgs });

  const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
    { pubkey: hookWhitelistKey, isSigner: false, isWritable: false },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: vaultStateKey, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: destinationTokenAccount, isSigner: false, isWritable: true }
  ];

  if (twinMintKey) {
    keys.push({
      pubkey: twinMintKey,
      isSigner: false,
      isWritable: true
    });
  }

  keys.push(
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: factoryStateKey, isSigner: false, isWritable: false },
    { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys,
      data: unshieldData
    })
  );

  const lookupTables: AddressLookupTableAccount[] = [];
  if (params.lookupTable) {
    try {
      const tableKey = new PublicKey(params.lookupTable);
      const lookupResponse = await connection.getAddressLookupTable(tableKey);
      if (lookupResponse.value) {
        lookupTables.push(lookupResponse.value);
      } else {
        console.warn(`[unwrap] lookup table ${tableKey.toBase58()} not found`);
      }
    } catch (error) {
      console.warn('[unwrap] failed to resolve lookup table', error);
    }
  }

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');

  let signature: string;
  if (lookupTables.length > 0) {
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    }).compileToV0Message(lookupTables);
    const transaction = new VersionedTransaction(message);
    signature = await wallet.sendTransaction(transaction, connection, { skipPreflight: false });
  } else {
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;
    signature = await wallet.sendTransaction(transaction, connection, { skipPreflight: false });
  }

  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );

  return signature;
}

export async function transfer(params: TransferParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const payer = wallet.publicKey;

  if (params.outputCommitments.length !== params.outputAmountCommitments.length) {
    throw new Error('Output commitment set mismatch');
  }

  const decodedProof = decodeProofPayload(params.proof);
  if (decodedProof.fields.length < 4) {
    throw new Error('Transfer proof missing public inputs');
  }

  const poolStateKey = new PublicKey(params.poolId);
  const originMintKey = new PublicKey(params.originMint);
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const nullifierSetKey = deriveNullifierSet(originMintKey);
  const noteLedgerKey = deriveNoteLedger(originMintKey);
  const verifyingKey = deriveVerifyingKey();
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    originMintKey
  );
  ensureMintActive(mintMapping);

  const expectedFieldCount =
    2 + params.nullifiers.length + params.outputCommitments.length + 2;
  if (decodedProof.fields.length !== expectedFieldCount) {
    console.warn('[transfer] unexpected public input count', {
      expectedFieldCount,
      actual: decodedProof.fields.length
    });
  }

  const transferArgs = {
    old_root: toFixedArray(decodedProof.fields[0]!, 'old_root'),
    new_root: toFixedArray(decodedProof.fields[1]!, 'new_root'),
    nullifiers: encodeFieldVector(params.nullifiers, 'nullifiers'),
    output_commitments: encodeFieldVector(params.outputCommitments, 'output_commitments'),
    output_amount_commitments: encodeFieldVector(
      params.outputAmountCommitments,
      'output_amount_commitments'
    ),
    proof: Buffer.from(decodedProof.proof),
    public_inputs: Buffer.from(decodedProof.publicInputs)
  };

  const instructions: TransactionInstruction[] = [];
  const computeLimitEnv =
    process.env.TRANSFER_COMPUTE_UNIT_LIMIT ??
    process.env.WRAP_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT;
  const resolvedLimit = (() => {
    if (computeLimitEnv !== undefined) {
      const parsed = Number(computeLimitEnv);
      if (!Number.isNaN(parsed)) {
        return Math.max(parsed, 0);
      }
    }
    return 1_200_000;
  })();
  if (resolvedLimit > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedLimit }));
  }

  const computePriceEnv =
    process.env.TRANSFER_COMPUTE_UNIT_PRICE ??
    process.env.WRAP_COMPUTE_UNIT_PRICE ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE;
  if (computePriceEnv) {
    const microLamports = Number(computePriceEnv);
    if (!Number.isNaN(microLamports) && microLamports > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }
  }

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolStateKey, isSigner: false, isWritable: true },
        { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
        { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
        { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
        { pubkey: mintMappingKey, isSigner: false, isWritable: false },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: verifyingKey, isSigner: false, isWritable: false },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      data: poolCoder.instruction.encode('private_transfer', { args: transferArgs })
    })
  );

  const lookupTables: AddressLookupTableAccount[] = [];
  if (params.lookupTable) {
    try {
      const tableKey = new PublicKey(params.lookupTable);
      const response = await connection.getAddressLookupTable(tableKey);
      if (response.value) {
        lookupTables.push(response.value);
      }
    } catch (error) {
      console.warn('[transfer] failed to load lookup table', error);
    }
  }

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  let signature: string;

  if (lookupTables.length > 0) {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(message);
    signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
  } else {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = payer;
    tx.recentBlockhash = latestBlockhash.blockhash;
    signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
  }

  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );

  return signature;
}

export async function transferFrom(params: TransferFromParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const spender = wallet.publicKey;
  if (!spender) {
    throw new Error('Wallet public key missing');
  }

  if (params.outputCommitments.length !== params.outputAmountCommitments.length) {
    throw new Error('Output commitment set mismatch');
  }

  const allowanceAmount = BigInt(params.allowanceAmount);
  if (allowanceAmount <= 0n) {
    throw new Error('Allowance amount must be positive');
  }

  const spendAmount = BigInt(params.spendAmount);
  if (spendAmount <= 0n) {
    throw new Error('Spend amount must be positive');
  }

  // CRITICAL FIX: Verify spend amount matches allowance amount
  if (spendAmount !== allowanceAmount) {
    throw new Error(`Spend amount (${spendAmount}) must match allowance amount (${allowanceAmount})`);
  }

  const decodedProof = decodeProofPayload(params.proof);
  if (decodedProof.fields.length < 4) {
    throw new Error('Transfer proof missing public inputs');
  }

  const poolStateKey = new PublicKey(params.poolId);
  const originMintKey = new PublicKey(params.originMint);
  const allowanceOwnerKey = new PublicKey(params.allowanceOwner);
  const allowanceKey = deriveAllowanceAccount(poolStateKey, allowanceOwnerKey, spender);
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const nullifierSetKey = deriveNullifierSet(originMintKey);
  const noteLedgerKey = deriveNoteLedger(originMintKey);
  const verifyingKey = deriveVerifyingKey();
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    originMintKey
  );
  ensureMintActive(mintMapping);

  const expectedFieldCount =
    2 + params.nullifiers.length + params.outputCommitments.length + 2;
  if (decodedProof.fields.length !== expectedFieldCount) {
    console.warn('[transfer_from] unexpected public input count', {
      expectedFieldCount,
      actual: decodedProof.fields.length
    });
  }

  const transferArgs = {
    old_root: toFixedArray(decodedProof.fields[0]!, 'old_root'),
    new_root: toFixedArray(decodedProof.fields[1]!, 'new_root'),
    nullifiers: encodeFieldVector(params.nullifiers, 'nullifiers'),
    output_commitments: encodeFieldVector(params.outputCommitments, 'output_commitments'),
    output_amount_commitments: encodeFieldVector(
      params.outputAmountCommitments,
      'output_amount_commitments'
    ),
    proof: Buffer.from(decodedProof.proof),
    public_inputs: Buffer.from(decodedProof.publicInputs)
  };

  const transferFromArgs = {
    transfer: transferArgs,
    allowance_amount: new BN(allowanceAmount.toString()),
    spend_amount: new BN(spendAmount.toString())
  };

  const instructions: TransactionInstruction[] = [];
  const computeLimitEnv =
    process.env.TRANSFER_COMPUTE_UNIT_LIMIT ??
    process.env.WRAP_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT;
  const resolvedLimit = (() => {
    if (computeLimitEnv !== undefined) {
      const parsed = Number(computeLimitEnv);
      if (!Number.isNaN(parsed)) {
        return Math.max(parsed, 0);
      }
    }
    return 1_200_000;
  })();
  if (resolvedLimit > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedLimit }));
  }

  const computePriceEnv =
    process.env.TRANSFER_COMPUTE_UNIT_PRICE ??
    process.env.WRAP_COMPUTE_UNIT_PRICE ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE;
  if (computePriceEnv) {
    const microLamports = Number(computePriceEnv);
    if (!Number.isNaN(microLamports) && microLamports > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }
  }

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolStateKey, isSigner: false, isWritable: true },
        { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
        { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
        { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: verifyingKey, isSigner: false, isWritable: false },
        { pubkey: mintMappingKey, isSigner: false, isWritable: false },
        { pubkey: allowanceKey, isSigner: false, isWritable: true },
        { pubkey: allowanceOwnerKey, isSigner: false, isWritable: false },
        { pubkey: spender, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      data: poolCoder.instruction.encode('transfer_from', { args: transferFromArgs })
    })
  );

  const lookupTables: AddressLookupTableAccount[] = [];
  if (params.lookupTable) {
    try {
      const tableKey = new PublicKey(params.lookupTable);
      const response = await connection.getAddressLookupTable(tableKey);
      if (response.value) {
        lookupTables.push(response.value);
      }
    } catch (error) {
      console.warn('[transfer_from] failed to load lookup table', error);
    }
  }

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  let signature: string;

  if (lookupTables.length > 0) {
    const message = new TransactionMessage({
      payerKey: spender,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(message);
    signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
  } else {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = spender;
    tx.recentBlockhash = latestBlockhash.blockhash;
    signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
  }

  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );

  return signature;
}

export async function approveSplToken(params: ApproveSplTokenParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const owner = wallet.publicKey;
  const programId = resolveSplProgram(params.program);
  const mintKey = new PublicKey(params.mint);
  const delegateKey = new PublicKey(params.delegate);
  const sourceAccount = params.ownerTokenAccount
    ? new PublicKey(params.ownerTokenAccount)
    : await getAssociatedTokenAddress(mintKey, owner, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const amount = BigInt(params.amount);

  const instruction = createApproveInstruction(
    sourceAccount,
    delegateKey,
    owner,
    amount,
    [],
    programId
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = owner;
  transaction.recentBlockhash = latestBlockhash.blockhash;

  const signature = await wallet.sendTransaction(transaction, connection, { skipPreflight: false });
  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );
  return signature;
}

export async function revokeSplTokenApproval(params: RevokeSplTokenParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const owner = wallet.publicKey;
  const programId = resolveSplProgram(params.program);
  const mintKey = new PublicKey(params.mint);
  const sourceAccount = params.ownerTokenAccount
    ? new PublicKey(params.ownerTokenAccount)
    : await getAssociatedTokenAddress(mintKey, owner, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const instruction = createRevokeInstruction(sourceAccount, owner, [], programId);

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = owner;
  transaction.recentBlockhash = latestBlockhash.blockhash;

  const signature = await wallet.sendTransaction(transaction, connection, { skipPreflight: false });
  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );
  return signature;
}

// Cache and throttle for getTokenMetadata to prevent excessive getAccountInfo calls
interface MetadataCacheEntry {
  data: { name: string; symbol: string; uri: string } | null;
  timestamp: number;
}

const metadataCache = new Map<string, MetadataCacheEntry>();
const metadataThrottle = new Map<string, Promise<{ name: string; symbol: string; uri: string } | null>>();
const CACHE_TTL_MS = 5_000; // Cache for 5 seconds
const THROTTLE_WINDOW_MS = 5_000; // Max once every 5 seconds per mint

function getCacheKey(mint: PublicKey): string {
  return mint.toBase58();
}

export async function getTokenMetadata(connection: Connection, mint: PublicKey): Promise<{ name: string; symbol: string; uri: string } | null> {
  const cacheKey = getCacheKey(mint);
  const now = Date.now();
  
  // Check cache first
  const cached = metadataCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }
  
  // Check if there's already a pending request for this mint
  const pending = metadataThrottle.get(cacheKey);
  if (pending) {
    return pending;
  }
  
  // Create new request
  const fetchPromise = (async () => {
    try {
      const metadataKey = deriveTokenMetadata(mint);
      const account = await connection.getAccountInfo(metadataKey, 'confirmed');
      if (!account) {
        const result: { name: string; symbol: string; uri: string } | null = null;
        metadataCache.set(cacheKey, { data: result, timestamp: now });
        return result;
      }
      const decoded = factoryCoder.accounts.decode('TokenMetadata', account.data);
      const result = {
        name: decoded.name,
        symbol: decoded.symbol,
        uri: decoded.uri
      };
      metadataCache.set(cacheKey, { data: result, timestamp: now });
      return result;
    } catch (error) {
      console.warn('[getTokenMetadata] Failed to fetch metadata:', error);
      const result: { name: string; symbol: string; uri: string } | null = null;
      metadataCache.set(cacheKey, { data: result, timestamp: now });
      return result;
    } finally {
      // Remove from throttle map after a delay to allow throttling
      setTimeout(() => {
        metadataThrottle.delete(cacheKey);
      }, THROTTLE_WINDOW_MS);
    }
  })();
  
  metadataThrottle.set(cacheKey, fetchPromise);
  return fetchPromise;
}

export async function resolvePublicKey(maybeKey: string | undefined, fallback: PublicKey): Promise<PublicKey> {
  if (!maybeKey) {
    return fallback;
  }
  return new PublicKey(maybeKey);
}

export async function mintNativeZToken(params: MintNativeZTokenParams): Promise<MintNativeZTokenResult> {
  assertWallet(params.wallet);
  const { connection, wallet } = params;

  // Generate a new mint keypair
  const mintKeypair = Keypair.generate();
  const originMint = mintKeypair.publicKey;
  const tokenProgramId = TOKEN_2022_PROGRAM_ID;

  // Derive all PDAs
  const factoryState = deriveFactoryState();
  const factoryConfig = deriveFactoryConfig();
  const mintMapping = deriveMintMapping(originMint);
  const metadata = deriveTokenMetadata(originMint);
  const poolState = derivePoolState(originMint);
  const vaultState = deriveVaultState(originMint);
  const commitmentTree = deriveCommitmentTree(originMint);
  const nullifierSet = deriveNullifierSet(originMint);
  const noteLedger = deriveNoteLedger(originMint);
  const hookConfig = deriveHookConfig(originMint);
  const hookWhitelist = deriveHookWhitelist(originMint);
  const verifyingKey = deriveVerifyingKey();

  // Factory config currently holds legacy program IDs on devnet. Skip passing it so the
  // on-chain program falls back to its baked-in configuration.
  const factoryConfigInfo = null;
  const factoryConfigMeta = factoryConfigInfo
    ? { pubkey: factoryConfig, isSigner: false, isWritable: true }
    : { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false };

  const userTokenAccount = await getAssociatedTokenAddress(
    originMint,
    wallet.publicKey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[mintNativeZToken]', {
      originMint: originMint.toBase58(),
      mintMapping: mintMapping.toBase58(),
      poolState: poolState.toBase58(),
    });
  }
  const instructions: TransactionInstruction[] = [];

  // Build mint_native_ztoken instruction
  const mintData = factoryCoder.instruction.encode('mint_native_ztoken', {
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    decimals: params.decimals,
    initial_supply: new BN(params.initialSupply.toString()),
    feature_flags: params.featureFlags ? { some: params.featureFlags } : null,
    fee_bps_override: params.feeBpsOverride ? { some: params.feeBpsOverride } : null,
  });

  const mintKeys = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: originMint, isSigner: true, isWritable: true }, // mint (keypair)
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: mintMapping, isSigner: false, isWritable: true },
    factoryConfigMeta,
    { pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false }, // pool_program
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false }, // vault_program
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: vaultState, isSigner: false, isWritable: true },
    { pubkey: commitmentTree, isSigner: false, isWritable: true },
    { pubkey: nullifierSet, isSigner: false, isWritable: true },
    { pubkey: noteLedger, isSigner: false, isWritable: true },
    { pubkey: hookConfig, isSigner: false, isWritable: true },
    { pubkey: hookWhitelist, isSigner: false, isWritable: true },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  instructions.push(
    new TransactionInstruction({
      programId: FACTORY_PROGRAM_ID,
      keys: mintKeys,
      data: mintData,
    })
  );

  // Add compute budget
  instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000, // High limit for minting + pool/vault initialization
    })
  );

  const computePriceEnv =
    process.env.MINT_COMPUTE_UNIT_PRICE ?? process.env.NEXT_PUBLIC_MINT_COMPUTE_UNIT_PRICE;
  if (computePriceEnv) {
    const microLamports = Number(computePriceEnv);
    if (!Number.isNaN(microLamports) && microLamports > 0) {
      instructions.splice(1, 0, ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }
  }

  // Send transaction
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = latestBlockhash.blockhash;
  
  // Sign with mint keypair
  transaction.partialSign(mintKeypair);
  
  const signature = await wallet.sendTransaction(transaction, connection, { skipPreflight: false });

  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );

  return {
    signature,
    originMint: originMint.toBase58(),
    poolId: poolState.toBase58(),
    metadataAccount: metadata.toBase58(),
    mintMapping: mintMapping.toBase58(),
    decimals: params.decimals,
    symbol: params.symbol,
    uri: params.uri
  };
}
