import { Buffer } from 'buffer';
import { createHash } from 'crypto';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  MessageV0,
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
import vaultIdl from '../idl/ptf_vault.json';
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
const vaultCoder = new BorshCoder(vaultIdl as Idl);

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
  keypair?: Keypair; // Optional keypair for signing VersionedTransaction in test scenarios
  // lookupTable and lookupTableAuthority removed - addresses are now derived programmatically
}

interface UnwrapParams extends BaseParams {
  destination: string;
  mode: 'origin' | 'ztkn' | 'ptkn';
  proof: ProofResponse;
  // lookupTable removed - addresses are now derived programmatically
  twinMint?: string;
  keypair?: Keypair; // Added for test scenarios to sign VersionedTransaction
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
  // lookupTable removed - addresses are now derived programmatically
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

interface PreparePoolParams {
  connection: Connection;
  wallet: WalletContextState;
  originMint: string;
}

interface PreparePoolResult {
  vaultInitialized: boolean;
  poolInitialized: boolean;
  lookupTableCreated: boolean;
  lookupTableAddress?: string;
  actions: string[];
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
  lookupTable?: PublicKey | null; // ALT address for transaction size optimization (one per mint)
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
  
  // Decode MintMapping account
  // Note: Old accounts were 81 bytes (without lookup_table), new are 114 bytes (with lookup_table Option<Pubkey>)
  // The decoder will handle this automatically based on the IDL
  const decoded = factoryCoder.accounts.decode('MintMapping', account.data) as any;
  
  // Normalize field names (Anchor uses snake_case, we use camelCase)
  const lookupTableValue = decoded.lookupTable ?? decoded.lookup_table ?? null;
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
    lookupTable: lookupTableValue ? new PublicKey(lookupTableValue) : null
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
    // LAZY INITIALIZATION: If pool doesn't exist yet, pending_shield can't be active
    if (!accountInfo) {
      if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
        console.info('[wrap] Pool state account missing - pool not initialized yet, pending_shield cannot be active');
      }
      return; // Pool doesn't exist, so pending_shield can't be active
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


type InitializePoolAccountDef = {
  name: string;
  signer?: boolean;
  writable?: boolean;
  optional?: boolean;
};

function buildInitializePoolInstruction(args: {
  wallet: WalletContextState;
  poolState: PublicKey;
  nullifierSet: PublicKey;
  noteLedger: PublicKey;
  commitmentTree: PublicKey;
  hookConfig: PublicKey;
  hookWhitelist: PublicKey;
  vaultState: PublicKey;
  originMint: PublicKey;
  mintMapping: PublicKey;
  factoryState: PublicKey;
  verifyingKey: PublicKey;
  tokenProgramId: PublicKey;
}): TransactionInstruction {
  const FEATURE_PRIVATE_TRANSFER_ENABLED = 1;
  const FEATURE_ALLOWANCES_ENABLED = 2;
  const features = FEATURE_PRIVATE_TRANSFER_ENABLED | FEATURE_ALLOWANCES_ENABLED;
  const feeBps = 0;

  const initPoolData = poolCoder.instruction.encode('initialize_pool', {
    fee_bps: feeBps,
    features
  });

  const poolAccounts: Record<string, PublicKey> = {
    authority: args.wallet.publicKey!,
    pool_state: args.poolState,
    nullifier_set: args.nullifierSet,
    note_ledger: args.noteLedger,
    commitment_tree: args.commitmentTree,
    hook_config: args.hookConfig,
    hook_whitelist: args.hookWhitelist,
    vault_state: args.vaultState,
    origin_mint: args.originMint,
    mint_mapping: args.mintMapping,
    factory_state: args.factoryState,
    twin_mint: POOL_PROGRAM_ID,
    verifier_program: VERIFIER_PROGRAM_ID,
    verifying_key: args.verifyingKey,
    payer: args.wallet.publicKey!,
    system_program: SystemProgram.programId,
    token_program: args.tokenProgramId
  };

  const ixDef = (poolIdl as Idl).instructions?.find((item) => item.name === 'initialize_pool');
  if (!ixDef) {
    throw new Error('initialize_pool instruction not found in IDL');
  }

  const accounts = ixDef.accounts as InitializePoolAccountDef[];
  const keys = accounts.map((account) => {
    const pubkey = poolAccounts[account.name];
    if (!pubkey) {
      if (account.optional) {
        return { pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false };
      }
      throw new Error(`Missing account mapping for ${account.name}`);
    }
    return {
      pubkey,
      isSigner: account.signer ?? false,
      isWritable: account.writable ?? false
    };
  });

  return new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys,
    data: initPoolData
  });
}

async function waitForAccountExists(
  connection: Connection,
  account: PublicKey,
  timeoutMs: number = 30_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await connection.getAccountInfo(account, 'confirmed');
    if (info) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for account ${account.toBase58()} to initialize`);
}

async function waitForLookupTableActivation(
  connection: Connection,
  lookupTableAddress: PublicKey,
  timeoutMs: number = 120_000
): Promise<void> {
  const start = Date.now();
  const maxWaitSlots = 5; // Wait up to 5 slots for activation
  let initialSlot: number | null = null;
  
  while (Date.now() - start < timeoutMs) {
    const lookupTable = await connection.getAddressLookupTable(lookupTableAddress);
    if (lookupTable.value) {
      if (initialSlot === null) {
        initialSlot = await connection.getSlot('confirmed');
      }
      
      const currentSlot = await connection.getSlot('confirmed');
      const deactivationSlot = lookupTable.value.state.deactivationSlot;
      
      // Lookup table is active if deactivationSlot is null
      // OR if it exists and has addresses (on test validator, activation can be immediate)
      if (deactivationSlot === null) {
        // Fully activated
        return;
      }
      
      // On test validator, lookup tables often activate quickly
      // If we've waited several slots and the table exists with addresses, proceed
      if (currentSlot > (initialSlot + maxWaitSlots) && lookupTable.value.state.addresses.length > 0) {
        // Give it one more slot and check again
        await sleep(500);
        const finalCheck = await connection.getAddressLookupTable(lookupTableAddress);
        if (finalCheck.value?.state.deactivationSlot === null || (finalCheck.value?.state?.addresses && finalCheck.value.state.addresses.length > 0)) {
          // Table exists and has addresses, consider it ready
          return;
        }
      }
    }
    await sleep(500);
  }
  
  // Final check - if table exists with addresses, proceed anyway (test validator quirk)
  const finalCheck = await connection.getAddressLookupTable(lookupTableAddress);
  if (finalCheck.value?.state?.addresses && finalCheck.value.state.addresses.length > 0) {
    console.warn(`[waitForLookupTableActivation] Lookup table exists with addresses but activation status unclear. Proceeding anyway.`);
    return;
  }
  
  throw new Error(`Lookup table ${lookupTableAddress.toBase58()} not activated within ${timeoutMs}ms`);
}

export async function preparePool(params: PreparePoolParams): Promise<PreparePoolResult> {
  assertWallet(params.wallet);
  const { connection, wallet } = params;
  const originMintKey = new PublicKey(params.originMint);
  const poolState = derivePoolState(originMintKey);
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const nullifierSet = deriveNullifierSet(originMintKey);
  const noteLedger = deriveNoteLedger(originMintKey);
  const hookConfig = deriveHookConfig(originMintKey);
  const hookWhitelist = deriveHookWhitelist(originMintKey);
  const vaultState = deriveVaultState(originMintKey);
  const mintMappingKey = deriveMintMapping(originMintKey);
  const factoryState = deriveFactoryState();
  const verifyingKey = deriveVerifyingKey();

  const [poolAccount, vaultAccount, commitmentTreeAccount, mintAccount] = await Promise.all([
    connection.getAccountInfo(poolState, 'confirmed'),
    connection.getAccountInfo(vaultState, 'confirmed'),
    connection.getAccountInfo(commitmentTreeKey, 'confirmed'),
    connection.getAccountInfo(originMintKey, 'confirmed')
  ]);

  if (!mintAccount) {
    throw new Error('Mint account not found');
  }

  const tokenProgramId = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  // Fetch MintMapping to check if lookup_table is already set
  const { decoded: mintMapping } = await fetchMintMappingAccount(connection, originMintKey);
  
  const result: PreparePoolResult = {
    vaultInitialized: false,
    poolInitialized: false,
    lookupTableCreated: false,
    actions: []
  };

  // Create/extend ALT for shield transactions if not already set
  // Note: We'll get the recent slot right before creating ALT to ensure it's current
  let lookupTableAddress: PublicKey | null = null;
  if (mintMapping.lookupTable) {
    // ALT already exists - verify it and extend if needed
    lookupTableAddress = mintMapping.lookupTable;
    result.lookupTableAddress = lookupTableAddress.toBase58();
    
    const lookupTable = await connection.getAddressLookupTable(lookupTableAddress);
    if (!lookupTable.value) {
      throw new Error(`Lookup table ${lookupTableAddress.toBase58()} stored in MintMapping does not exist`);
    }
    
    // Check if all required addresses are in the ALT
    const shieldClaim = deriveShieldClaim(poolState);
    const requiredAddresses = [
      poolState,
      hookConfig,
      hookWhitelist,
      nullifierSet,
      commitmentTreeKey,
      noteLedger,
      vaultState,
      VERIFIER_PROGRAM_ID,
      verifyingKey,
      shieldClaim,
      originMintKey,
      mintMappingKey,
      factoryState,
      VAULT_PROGRAM_ID,
      tokenProgramId,
      SystemProgram.programId,
      SYSVAR_RENT_PUBKEY
    ];
    
    const existingAddresses = lookupTable.value.state.addresses;
    const missingAddresses = requiredAddresses.filter(
      (addr) => !existingAddresses.some((existing) => existing.equals(addr))
    );
    
    if (missingAddresses.length > 0) {
      // Extend ALT with missing addresses
      const recentSlot = await connection.getSlot('confirmed');
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        authority: wallet.publicKey!,
        payer: wallet.publicKey!,
        lookupTable: lookupTableAddress,
        addresses: missingAddresses
      });
      
      const extendBlockhash = await connection.getLatestBlockhash('confirmed');
      const extendTx = new Transaction().add(extendIx);
      extendTx.feePayer = wallet.publicKey!;
      extendTx.recentBlockhash = extendBlockhash.blockhash;
      const extendSig = await wallet.sendTransaction(extendTx, connection, { skipPreflight: false });
      await waitForSignatureConfirmation(
        connection,
        extendSig,
        extendBlockhash.blockhash,
        extendBlockhash.lastValidBlockHeight
      );
      result.actions.push('alt-extended');
    }
  } else {
    // ALT doesn't exist - create it
    const shieldClaim = deriveShieldClaim(poolState);
    const allAddresses = [
      poolState,
      hookConfig,
      hookWhitelist,
      nullifierSet,
      commitmentTreeKey,
      noteLedger,
      vaultState,
      VERIFIER_PROGRAM_ID,
      verifyingKey,
      shieldClaim,
      originMintKey,
      mintMappingKey,
      factoryState,
      VAULT_PROGRAM_ID,
      tokenProgramId,
      SystemProgram.programId,
      SYSVAR_RENT_PUBKEY
    ];
    
    // Remove duplicates
    const uniqueAddresses = Array.from(
      new Map(allAddresses.map((addr) => [addr.toBase58(), addr])).values()
    );
    
    // Create ALT - get recent slot right before creating to ensure it's current
    // The slot needs to be recent when the transaction is processed
    // Get slot and blockhash together, then create the lookup table instruction
    const [createBlockhash, recentSlot] = await Promise.all([
      connection.getLatestBlockhash('confirmed'),
      connection.getSlot('confirmed')
    ]);
    
    const [createIx, newLookupTableAddress] = AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey!,
      payer: wallet.publicKey!,
      recentSlot
    });
    
    // Prepare extend instruction (will be sent after create confirms)
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      authority: wallet.publicKey!,
      payer: wallet.publicKey!,
      lookupTable: newLookupTableAddress,
      addresses: uniqueAddresses
    });
    
    // Send create transaction
    // Use skipPreflight: true to avoid slot recency checks during simulation
    const createTx = new Transaction().add(createIx);
    createTx.feePayer = wallet.publicKey!;
    createTx.recentBlockhash = createBlockhash.blockhash;
    const createSig = await wallet.sendTransaction(createTx, connection, { skipPreflight: true });
    await waitForSignatureConfirmation(
      connection,
      createSig,
      createBlockhash.blockhash,
      createBlockhash.lastValidBlockHeight
    );
    
    // Wait a moment for the lookup table to be created before extending
    await sleep(500);
    
    // Send extend transaction
    const extendBlockhash = await connection.getLatestBlockhash('confirmed');
    const extendTx = new Transaction().add(extendIx);
    extendTx.feePayer = wallet.publicKey!;
    extendTx.recentBlockhash = extendBlockhash.blockhash;
    const extendSig = await wallet.sendTransaction(extendTx, connection, { skipPreflight: false });
    await waitForSignatureConfirmation(
      connection,
      extendSig,
      extendBlockhash.blockhash,
      extendBlockhash.lastValidBlockHeight
    );
    
    // Wait for ALT activation
    await waitForLookupTableActivation(connection, newLookupTableAddress);
    
    // Store ALT address in MintMapping via set_lookup_table instruction
    const setLookupTableData = factoryCoder.instruction.encode('set_lookup_table', {
      lookup_table: newLookupTableAddress
    });
    
    const setLookupTableIx = new TransactionInstruction({
      programId: FACTORY_PROGRAM_ID,
      keys: [
        { pubkey: factoryState, isSigner: false, isWritable: true },
        { pubkey: mintMappingKey, isSigner: false, isWritable: true },
        { pubkey: newLookupTableAddress, isSigner: false, isWritable: false },
        { pubkey: wallet.publicKey!, isSigner: true, isWritable: false } // payer
      ],
      data: setLookupTableData
    });
    
    const setBlockhash = await connection.getLatestBlockhash('confirmed');
    const setTx = new Transaction().add(setLookupTableIx);
    setTx.feePayer = wallet.publicKey!;
    setTx.recentBlockhash = setBlockhash.blockhash;
    const setSig = await wallet.sendTransaction(setTx, connection, { skipPreflight: false });
    await waitForSignatureConfirmation(
      connection,
      setSig,
      setBlockhash.blockhash,
      setBlockhash.lastValidBlockHeight
    );
    
    // Verify the lookup table was actually stored in MintMapping
    await sleep(500); // Give it a moment to settle
    const { decoded: updatedMintMapping } = await fetchMintMappingAccount(connection, originMintKey);
    if (!updatedMintMapping.lookupTable || updatedMintMapping.lookupTable.toBase58() === '11111111111111111111111111111111') {
      throw new Error(`Failed to store lookup table in MintMapping. Expected ${newLookupTableAddress.toBase58()}, got ${updatedMintMapping.lookupTable?.toBase58() ?? 'null'}`);
    }
    
    lookupTableAddress = newLookupTableAddress;
    result.lookupTableCreated = true;
    result.lookupTableAddress = lookupTableAddress.toBase58();
    result.actions.push('alt-created');
  }

  if (!vaultAccount) {
    const vaultInitData = vaultCoder.instruction.encode('initialize_vault', {
      pool_authority: poolState
    });
    const vaultInitIx = new TransactionInstruction({
      programId: VAULT_PROGRAM_ID,
      keys: [
        { pubkey: vaultState, isSigner: false, isWritable: true },
        { pubkey: originMintKey, isSigner: false, isWritable: false },
        { pubkey: wallet.publicKey!, isSigner: true, isWritable: true },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: vaultInitData
    });

    const vaultBlockhash = await connection.getLatestBlockhash('confirmed');
    const vaultTx = new Transaction().add(vaultInitIx);
    vaultTx.feePayer = wallet.publicKey!;
    vaultTx.recentBlockhash = vaultBlockhash.blockhash;
    const vaultSig = await wallet.sendTransaction(vaultTx, connection, { skipPreflight: false });
    await waitForSignatureConfirmation(
      connection,
      vaultSig,
      vaultBlockhash.blockhash,
      vaultBlockhash.lastValidBlockHeight
    );
    await waitForAccountExists(connection, vaultState);
    result.vaultInitialized = true;
    result.actions.push('vault');
  }

  if (!poolAccount) {
    const initPoolIx = buildInitializePoolInstruction({
      wallet,
      poolState,
      nullifierSet,
      noteLedger,
      commitmentTree: commitmentTreeKey,
      hookConfig,
      hookWhitelist,
      vaultState,
      originMint: originMintKey,
      mintMapping: mintMappingKey,
      factoryState,
      verifyingKey,
      tokenProgramId
    });
    const initBlockhash = await connection.getLatestBlockhash('confirmed');
    const initTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      initPoolIx
    );
    initTx.feePayer = wallet.publicKey!;
    initTx.recentBlockhash = initBlockhash.blockhash;
    const initSig = await wallet.sendTransaction(initTx, connection, { skipPreflight: false });
    await waitForSignatureConfirmation(
      connection,
      initSig,
      initBlockhash.blockhash,
      initBlockhash.lastValidBlockHeight
    );
    await waitForAccountExists(connection, poolState);
    await waitForAccountExists(connection, commitmentTreeKey);
    result.poolInitialized = true;
    result.actions.push('pool');
  } else if (!commitmentTreeAccount) {
    throw new Error(
      'Commitment tree account missing even though pool is initialized. Run repair tooling.'
    );
  }

  return result;
}

// ensureLookupTableForMint and setLookupTableForMint functions removed - addresses are now derived programmatically

export async function wrap(params: WrapParams): Promise<string> {
  assertWallet(params.wallet);

  const wallet = params.wallet;
  const connection = params.connection;
  // lookupTableAuthority removed - addresses are now derived programmatically

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
  const factoryState = deriveFactoryState(); // Needed for lazy initialization
  const twinMintKey = params.twinMint ? new PublicKey(params.twinMint) : null;
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    originMintKey
  );
  ensureMintActive(mintMapping);
  
  // Store mintMapping for later use (ALT lookup)
  
  // Wait for pending_shield to be inactive before starting a new shield
  // This prevents PendingShieldInFlight errors from previous incomplete operations
  // LAZY INITIALIZATION: If pool doesn't exist yet, pending_shield can't be active
  try {
    await waitForPendingShieldInactive(connection, poolState, 3000); // Short timeout first
  } catch (error) {
    // Check if pool exists - if not, pending_shield can't be active (lazy initialization)
    const poolAccountInfo = await connection.getAccountInfo(poolState, 'confirmed');
    if (!poolAccountInfo) {
      // Pool doesn't exist yet - pending_shield can't be active, proceed with shield
      if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
        console.info('[wrap] Pool not initialized yet - pending_shield cannot be active, proceeding with shield');
      }
      // Continue to shield instruction which will initialize the pool
    } else {
      // Pool exists - check for stuck pending_shield state
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
  }

  const poolAccountInfo = await connection.getAccountInfo(poolState, 'confirmed');
  if (!poolAccountInfo) {
    throw new Error(
      'Pool is not initialized. Run preparePool(originMint) before submitting a shield transaction.'
    );
  }
  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey);
  if (!commitmentTreeAccount) {
    throw new Error(
      'Commitment tree account missing. Run preparePool(originMint) before submitting a shield transaction.'
    );
  }
  const treeState = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
  const recipientKey = params.recipient ? new PublicKey(params.recipient) : wallet.publicKey;
  const depositId = BigInt(params.depositId);
  const blinding = BigInt(params.blinding);
  const amount = params.amount;

  const amountCommitmentBytes = await poseidonHashMany([amount, blinding]);

  // Determine which token program the mint uses
  const mintAccount = await connection.getAccountInfo(originMintKey, 'confirmed');
  if (!mintAccount) {
    throw new Error('Mint account not found');
  }
  const tokenProgramId = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) 
    ? TOKEN_2022_PROGRAM_ID 
    : TOKEN_PROGRAM_ID;

  const vaultTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    vaultState,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const depositorTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    wallet.publicKey,
    false,
    tokenProgramId,
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

  // Ensure vault token account exists (required for shield)
  const vaultTokenAccountInfo = await connection.getAccountInfo(vaultTokenAccount, 'confirmed');
  if (!vaultTokenAccountInfo) {
    // Create vault token account
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey!,
        vaultTokenAccount,
        vaultState,
        originMintKey,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  
  const depositorInfo = await connection.getAccountInfo(depositorTokenAccount);
  if (!depositorInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        depositorTokenAccount,
        wallet.publicKey,
        originMintKey,
        tokenProgramId,
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
    { pubkey: factoryState, isSigner: false, isWritable: false }, // Needed for program validation
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
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

  // Lookup tables removed - addresses are now derived programmatically by the program

  // Use mintMapping already fetched above to check if ALT is available
  let lookupTableAddress: PublicKey | null = null;
  let lookupTableAccount: any = null;
  
  if (mintMapping.lookupTable) {
    lookupTableAddress = mintMapping.lookupTable;
    try {
      const lookupTableResult = await connection.getAddressLookupTable(lookupTableAddress);
      if (lookupTableResult.value) {
        lookupTableAccount = lookupTableResult.value;
      }
    } catch (error: any) {
      console.warn(`[wrap] Failed to fetch lookup table ${lookupTableAddress.toBase58()}:`, error.message);
      // Continue without lookup table - will use regular Transaction
      lookupTableAddress = null;
      lookupTableAccount = null;
    }
  }

  let latestBlockhash = await connection.getLatestBlockhash('confirmed');
  
  const shieldInstructionSet = [...instructions, shieldInstruction];

  let shieldSignature: string | undefined;
  let shieldAttempts = 0;
  const maxShieldAttempts = 5;
  
  // Retry shield if it fails with PendingShieldInFlight (0x1793 = 6035)
  while (shieldAttempts < maxShieldAttempts) {
    shieldAttempts++;
    try {
      let shieldTransaction: Transaction | VersionedTransaction | null = null;
      
      if (lookupTableAccount && lookupTableAddress) {
        // Use VersionedTransaction with ALT to reduce transaction size
        const altAddresses = lookupTableAccount.state.addresses;
        const altAddressMap = new Map(altAddresses.map((addr: PublicKey, idx: number) => [addr.toBase58(), idx]));
        
        // Build addressTableLookups - separate accounts into writable and readonly indexes
        const writableIndexes: number[] = [];
        const readonlyIndexes: number[] = [];
        
        // Process shield instruction keys to identify which accounts are in ALT
        for (const accountMeta of shieldKeys) {
          const altIdx = altAddressMap.get(accountMeta.pubkey.toBase58());
          if (altIdx !== undefined && typeof altIdx === 'number' && accountMeta.pubkey.toBase58() !== wallet.publicKey.toBase58()) {
            // Account is in ALT and is not the wallet (signer must be direct)
            if (accountMeta.isWritable) {
              if (!writableIndexes.includes(altIdx)) {
                writableIndexes.push(altIdx);
              }
            } else {
              if (!readonlyIndexes.includes(altIdx)) {
                readonlyIndexes.push(altIdx);
              }
            }
          }
        }
        
        // Sort indexes for addressTableLookups
        writableIndexes.sort((a, b) => a - b);
        readonlyIndexes.sort((a, b) => a - b);
        
        const addressTableLookups = writableIndexes.length > 0 || readonlyIndexes.length > 0 ? [{
          accountKey: lookupTableAddress,
          writableIndexes,
          readonlyIndexes
        }] : [];
        
        // Build MessageV0 with addressTableLookups
        // Use the lookup table account to build addressTableLookups
        const addressTableLookupAccounts = [lookupTableAccount];
        
        const baseMessage = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: shieldInstructionSet
        });
        
        // Compile to V0 message with addressTableLookups
        // The compileToV0Message method accepts AddressLookupTableAccount[] as second parameter
        const messageV0 = baseMessage.compileToV0Message(addressTableLookupAccounts);
        
        shieldTransaction = new VersionedTransaction(messageV0);
        
        // Use wallet's signTransaction method if available (works with wallet adapters)
        // Otherwise, try to sign manually with keypair (for test scenarios)
        let signedTransaction: VersionedTransaction | null = null;
        
        if (wallet.signTransaction) {
          // Wallet adapter supports signing VersionedTransactions
          try {
            signedTransaction = await wallet.signTransaction(shieldTransaction);
            shieldSignature = await connection.sendRawTransaction(signedTransaction.serialize(), {
              skipPreflight: false
            });
          } catch (signError: any) {
            console.warn('[wrap] Failed to sign VersionedTransaction with wallet adapter:', signError);
            // Fall through to try keypair or regular transaction
            signedTransaction = null;
          }
        }
        
        // Fallback: try manual signing with keypair (for test scenarios)
        if (!signedTransaction) {
          let signerKeypair: Keypair | null = null;
          if (params.keypair) {
            signerKeypair = params.keypair;
          } else if ((wallet as any).secretKey) {
            // Wallet is already a Keypair
            signerKeypair = wallet as any;
          }
          
          if (signerKeypair) {
            shieldTransaction.sign([signerKeypair]);
            shieldSignature = await connection.sendRawTransaction(shieldTransaction.serialize(), {
              skipPreflight: false
            });
          } else {
            // Can't sign VersionedTransaction - fall back to regular Transaction
            console.warn('[wrap] Cannot sign VersionedTransaction, falling back to regular Transaction (may exceed size limits)');
            shieldTransaction = new Transaction().add(...shieldInstructionSet);
            shieldTransaction.feePayer = wallet.publicKey;
            shieldTransaction.recentBlockhash = latestBlockhash.blockhash;
            shieldSignature = await wallet.sendTransaction(shieldTransaction, connection, {
              skipPreflight: false
            });
          }
        }
      } else {
        // Fall back to regular Transaction if ALT not available
        shieldTransaction = new Transaction().add(...shieldInstructionSet);
        shieldTransaction.feePayer = wallet.publicKey;
        shieldTransaction.recentBlockhash = latestBlockhash.blockhash;
        shieldSignature = await wallet.sendTransaction(shieldTransaction, connection, {
          skipPreflight: false
        });
      }
      
      // Only break if we successfully sent the transaction
      if (shieldSignature) {
        break; // Success, exit retry loop
      }
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
                shieldInstructionSet[shieldInstructionSet.length - 1] = shieldInstruction;
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

  const finalizeLedgerInstructions: TransactionInstruction[] = [];
  if (resolvedComputeLimit > 0) {
    finalizeLedgerInstructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedComputeLimit }));
  }
  finalizeLedgerInstructions.push(finalizeLedgerInstruction);

  const ledgerBlockhash = await connection.getLatestBlockhash('confirmed');
  const finalizeLedgerTransaction = new Transaction().add(...finalizeLedgerInstructions);
  finalizeLedgerTransaction.feePayer = wallet.publicKey;
  finalizeLedgerTransaction.recentBlockhash = ledgerBlockhash.blockhash;
  const finalizeLedgerSignature = await wallet.sendTransaction(finalizeLedgerTransaction, connection, {
    skipPreflight: false
  });
  await waitForSignatureConfirmation(
    connection,
    finalizeLedgerSignature,
    ledgerBlockhash.blockhash,
    ledgerBlockhash.lastValidBlockHeight
  );

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
  
  // Check if there's change by looking at the field count
  // If there's change, we have: nullifiers + 2 change fields (commitment + amount_commitment) + 6 trailing fields
  // If no change, we have: nullifiers + 6 trailing fields (no change fields)
  const hasChange = decodedProof.fields.length >= (2 + nullifierCount + CHANGE_FIELD_COUNT + TRAILING_FIELD_COUNT);
  
  let changeCommitmentBytes: Uint8Array | null = null;
  let changeAmountCommitmentBytes: Uint8Array | null = null;
  let fieldOffset = 2 + nullifierCount;
  
  if (hasChange) {
    changeCommitmentBytes = decodedProof.fields[fieldOffset];
    changeAmountCommitmentBytes = decodedProof.fields[fieldOffset + 1];
    fieldOffset += CHANGE_FIELD_COUNT;
  }
  
  const amountFieldBytes = decodedProof.fields[fieldOffset];
  const feeFieldBytes = decodedProof.fields[fieldOffset + 1];
  const destinationFieldBytes = decodedProof.fields[fieldOffset + 2];
  const modeFieldBytes = decodedProof.fields[fieldOffset + 3];
  const mintFieldBytes = decodedProof.fields[fieldOffset + 4];
  const poolFieldBytes = decodedProof.fields[fieldOffset + 5];

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

  // Detect which token program the origin mint uses (needed for vault token account)
  const originMintInfo = await connection.getAccountInfo(originMintKey, 'confirmed');
  if (!originMintInfo) {
    throw new Error('Origin mint account not found');
  }
  const originTokenProgram = originMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) 
    ? TOKEN_2022_PROGRAM_ID 
    : TOKEN_PROGRAM_ID;

  const vaultTokenAccount = await getAssociatedTokenAddress(
    originMintKey,
    vaultStateKey,
    true,
    originTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  let twinMintKey: PublicKey | null = params.twinMint ? new PublicKey(params.twinMint) : null;
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    originMintKey
  );
  ensureMintActive(mintMapping);
  
  // Fetch lookup table if it exists (for reducing transaction size)
  let lookupTableAddress: PublicKey | null = null;
  let lookupTableAccount: any = null;
  if (mintMapping.lookupTable) {
    lookupTableAddress = mintMapping.lookupTable;
    try {
      const lookupTableResult = await connection.getAddressLookupTable(lookupTableAddress, { commitment: 'confirmed' });
      if (lookupTableResult.value) {
        lookupTableAccount = lookupTableResult;
        console.info(`[unwrap] Using existing lookup table: ${lookupTableAddress.toBase58()}`);
      } else {
        console.warn(`[unwrap] Lookup table ${lookupTableAddress.toBase58()} not found, falling back to regular transaction`);
        lookupTableAddress = null;
        lookupTableAccount = null;
      }
    } catch (error: any) {
      console.warn(`[unwrap] Failed to fetch lookup table ${lookupTableAddress?.toBase58() ?? 'unknown'}:`, error.message);
      lookupTableAddress = null;
      lookupTableAccount = null;
    }
  }
  
  // Lookup tables removed - addresses are now derived programmatically
  
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
  const destinationTokenProgram = redeemToTwin ? TOKEN_2022_PROGRAM_ID : originTokenProgram;
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
    output_commitments: hasChange && changeCommitmentBytes ? [Array.from(changeCommitmentBytes)] : [],
    output_amount_commitments: hasChange && changeAmountCommitmentBytes ? [Array.from(changeAmountCommitmentBytes)] : [],
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
    if (changeCommitmentBytes && unshieldArgs.output_commitments[0]) {
      compare('change_commitment', changeCommitmentBytes, unshieldArgs.output_commitments[0]);
    }
    if (changeAmountCommitmentBytes && unshieldArgs.output_amount_commitments[0]) {
      compare('change_amount_commitment', changeAmountCommitmentBytes, unshieldArgs.output_amount_commitments[0]);
    }
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

  // Only include twin_mint if we're redeeming to twin (ptkn mode)
  // If not redeeming to twin, use program ID as placeholder (Anchor optional account pattern)
  if (redeemToTwin && twinMintKey) {
    keys.push({
      pubkey: twinMintKey,
      isSigner: false,
      isWritable: true
    });
  } else {
    // Anchor treats an optional account as `None` when the slot equals the program id
    keys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  keys.push(
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: factoryStateKey, isSigner: false, isWritable: false },
    { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: originTokenProgram, isSigner: false, isWritable: false }, // Use originTokenProgram instead of TOKEN_PROGRAM_ID
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

  // Use Address Lookup Table if available to reduce transaction size
  const blockhash = await connection.getLatestBlockhash('confirmed');
  
  let signature: string | undefined;
  if (lookupTableAccount && lookupTableAddress) {
    // Use VersionedTransaction with ALT to reduce transaction size
    const altAddresses = lookupTableAccount.value.state.addresses;
    const altAddressMap = new Map(altAddresses.map((addr: PublicKey, idx: number) => [addr.toBase58(), idx]));
    
    // Build addressTableLookups - separate accounts into writable and readonly indexes
    const writableIndexes: number[] = [];
    const readonlyIndexes: number[] = [];
    
    // Process unshield instruction keys to identify which accounts are in ALT
    for (const accountMeta of keys) {
      const altIdx = altAddressMap.get(accountMeta.pubkey.toBase58());
      if (altIdx !== undefined && typeof altIdx === 'number' && accountMeta.pubkey.toBase58() !== wallet.publicKey.toBase58()) {
        // Account is in ALT and is not the wallet (signer must be direct)
        if (accountMeta.isWritable) {
          if (!writableIndexes.includes(altIdx)) {
            writableIndexes.push(altIdx);
          }
        } else {
          if (!readonlyIndexes.includes(altIdx)) {
            readonlyIndexes.push(altIdx);
          }
        }
      }
    }
    
    // Sort indexes for addressTableLookups
    writableIndexes.sort((a, b) => a - b);
    readonlyIndexes.sort((a, b) => a - b);
    
    const addressTableLookups = writableIndexes.length > 0 || readonlyIndexes.length > 0 ? [{
      accountKey: lookupTableAddress,
      writableIndexes,
      readonlyIndexes
    }] : [];
    
    const baseMessage = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions
    });
    
    const messageV0 = baseMessage.compileToV0Message([lookupTableAccount.value]);
    
    const versionedTransaction = new VersionedTransaction(messageV0);
    
    // Use wallet's signTransaction method if available (works with wallet adapters)
    // Otherwise, try to sign manually with keypair (for test scenarios)
    let signedTransaction: VersionedTransaction | null = null;
    
    if (wallet.signTransaction) {
      // Wallet adapter supports signing VersionedTransactions
      try {
        signedTransaction = await wallet.signTransaction(versionedTransaction);
        signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
          skipPreflight: false
        });
      } catch (signError: any) {
        console.warn('[unwrap] Failed to sign VersionedTransaction with wallet adapter:', signError);
        // Fall through to try keypair or regular transaction
        signedTransaction = null;
      }
    }
    
    // Fallback: try manual signing with keypair (for test scenarios)
    if (!signedTransaction) {
      let signerKeypair: Keypair | null = null;
      if (params.keypair) {
        signerKeypair = params.keypair;
      } else if ((wallet as any).secretKey) {
        // Wallet is already a Keypair (e.g., from createWalletAdapter in tests)
        signerKeypair = wallet as any;
      }
      
      if (signerKeypair) {
        versionedTransaction.sign([signerKeypair]);
        signature = await connection.sendRawTransaction(versionedTransaction.serialize(), {
          skipPreflight: false
        });
      } else {
        // Can't sign VersionedTransaction - fall back to regular Transaction
        console.warn('[unwrap] Cannot sign VersionedTransaction, falling back to regular Transaction (may exceed size limits)');
        const transaction = new Transaction().add(...instructions);
        transaction.feePayer = wallet.publicKey;
        transaction.recentBlockhash = blockhash.blockhash;
        signature = await wallet.sendTransaction(transaction, connection, {
          skipPreflight: false
        });
      }
    }
  } else {
    // Fallback to regular Transaction if no ALT is available
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = blockhash.blockhash;
    signature = await wallet.sendTransaction(transaction, connection, {
      skipPreflight: false
    });
  }
  
  if (!signature) {
    throw new Error('Failed to send unwrap transaction');
  }
  
  await waitForSignatureConfirmation(
    connection,
    signature,
    blockhash.blockhash,
    blockhash.lastValidBlockHeight
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
  
  // Lookup tables removed - addresses are now derived programmatically

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

  // Lookup tables removed - addresses are now derived programmatically
  
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer;
  tx.recentBlockhash = latestBlockhash.blockhash;
  const signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });

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
  
  // Lookup tables removed - addresses are now derived programmatically

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

  // Lookup tables removed - addresses are now derived programmatically
  
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(...instructions);
  tx.feePayer = spender;
  tx.recentBlockhash = latestBlockhash.blockhash;
  const signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });

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

  // Derive PDAs (only what's needed for minting - pool/vault will be initialized lazily on first shield)
  const factoryState = deriveFactoryState();
  const factoryConfig = deriveFactoryConfig();
  const mintMapping = deriveMintMapping(originMint);
  const metadata = deriveTokenMetadata(originMint);
  // Derive poolState for return value (not passed to instruction - will be initialized on first shield)
  const poolState = derivePoolState(originMint);

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

  // LAZY INITIALIZATION: Only include accounts needed for minting
  // Pool/vault infrastructure will be initialized on first shield
  const mintKeys = [
    { pubkey: factoryState, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: originMint, isSigner: true, isWritable: true }, // mint (keypair)
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: mintMapping, isSigner: false, isWritable: true },
    factoryConfigMeta,
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

  // Add compute budget (reduced since we're not initializing pool/vault)
  instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 200_000, // Lower limit for minting only (pool/vault initialized lazily on first shield)
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

  // Check payer balance before sending transaction
  // Estimate: 
  // - Mint account: ~0.00144 SOL (rent exemption)
  // - Metadata account: ~0.00323 SOL (rent exemption)
  // - MintMapping account: ~0.00000081 SOL (rent exemption)
  // - Pool state + vault state + commitment tree + nullifier set + note ledger + hook config + hook whitelist: ~0.01 SOL
  // - Transaction fees: ~0.000005 SOL
  // - Safety margin: 0.05 SOL
  // Total: ~0.065 SOL minimum, but use 0.1 SOL for safety
  const MIN_BALANCE_REQUIRED = 100_000_000; // 0.1 SOL
  const payerBalance = await connection.getBalance(wallet.publicKey, 'confirmed');
  if (payerBalance < MIN_BALANCE_REQUIRED) {
    const requiredSol = (MIN_BALANCE_REQUIRED / 1e9).toFixed(2);
    const currentSol = (payerBalance / 1e9).toFixed(4);
    throw new Error(
      `Insufficient SOL balance for token minting. ` +
      `Required: ${requiredSol} SOL, Current: ${currentSol} SOL. ` +
      `Please fund your wallet using the faucet or transfer SOL to your account.`
    );
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
