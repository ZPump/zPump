import { Buffer } from 'buffer';
import { createHash } from 'crypto';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
import {
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  MessageV0,
  MessageHeader,
  MessageCompiledInstruction,
  MessageAddressTableLookup,
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
  FACTORY_PROGRAM_ID,
  DEX_PROGRAM_ID
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
  derivePoolState,
  deriveDexPoolState
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
import {
  getZTokenPoolAccounts,
  fetchZTokenPoolRoot,
  generateDexShieldProof,
  generateDexTransferProof,
  generateDexTransferProofSimple,
  generateBatchTransferProof,
  generateBatchTransferFromProof,
  generateBatchLiquidityProof,
  proofToShieldArgs,
  proofToTransferArgs,
  createEmptyShieldArgs
} from './dex-ztoken-helpers';
import poolIdl from '../idl/ptf_pool.json';
import factoryIdl from '../idl/ptf_factory.json';
import vaultIdl from '../idl/ptf_vault.json';
import dexIdl from '../idl/ptf_dex.json';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createApproveInstruction,
  createRevokeInstruction,
  createInitializeMint2Instruction
} from '@solana/spl-token';
import {
  NATIVE_SOL_MINT,
  isNativeSol,
  getWrappedSolAccount,
  createWrapSolInstructions,
  createUnwrapSolInstruction,
  getWrappedSolBalance,
  checkWrappedSolBalance
} from './solWrapping';

const DEFAULT_SIGNATURE_TIMEOUT_MS = 60_000;
const SIGNATURE_POLL_INTERVAL_MS = 500;

const poolCoder = new BorshCoder(poolIdl as Idl);
const factoryCoder = new BorshCoder(factoryIdl as Idl);
const vaultCoder = new BorshCoder(vaultIdl as Idl);
const dexCoder = new BorshCoder(dexIdl as Idl);

export const MINT_STATUS = {
  UNKNOWN: 0,
  ACTIVE: 1,
  FROZEN: 2
} as const;

const SHIELD_CLAIM_STATUS = {
  INACTIVE: 0,
  PENDING_TREE: 1,
  AWAITING_LEDGER: 2,
  AWAITING_INVARIANT: 3,
  LEDGER_COMPLETE: 4
} as const;

type ShieldClaimAccount = {
  status: number;
  old_root?: Uint8Array;
  expires_at?: number | bigint;
  created_at?: number | bigint;
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

function buildManualMessageV0(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  recentBlockhash: string,
  lookupTableAccount: AddressLookupTableAccount,
  allSigners: PublicKey[]
): MessageV0 {
  const altAddresses = lookupTableAccount.state.addresses;
  const altAddressMap = new Map(altAddresses.map((addr: PublicKey, idx: number) => [addr.toBase58(), idx]));
  
  // Build staticAccountKeys in correct order: writable signers, readonly signers, writable non-signers, readonly non-signers
  const accountMetadata = new Map<string, { 
    pubkey: PublicKey; 
    isSigner: boolean; 
    isWritable: boolean; 
    firstOrder: number;
  }>();
  const signerSet = new Set(allSigners.map(s => s.toBase58()));
  let accountOrderCounter = 0;
  
  // Collect accounts from instructions in order
  for (const ix of instructions) {
    const programIdStr = ix.programId.toBase58();
    if (!altAddressMap.has(programIdStr)) {
      if (!accountMetadata.has(programIdStr)) {
        accountMetadata.set(programIdStr, {
          pubkey: ix.programId,
          isSigner: signerSet.has(programIdStr),
          isWritable: false,
          firstOrder: accountOrderCounter++
        });
      }
    }
    
    for (const meta of ix.keys) {
      const addrStr = meta.pubkey.toBase58();
      if (!altAddressMap.has(addrStr)) {
        const existing = accountMetadata.get(addrStr);
        if (existing) {
          if (meta.isWritable) {
            existing.isWritable = true;
          }
        } else {
          accountMetadata.set(addrStr, {
            pubkey: meta.pubkey,
            isSigner: signerSet.has(addrStr),
            isWritable: meta.isWritable,
            firstOrder: accountOrderCounter++
          });
        }
      }
    }
  }
  
  // Sort accounts into correct categories
  const writableSigners: Array<{pubkey: PublicKey; order: number}> = [];
  const readonlySigners: Array<{pubkey: PublicKey; order: number}> = [];
  const writableNonSigners: Array<{pubkey: PublicKey; order: number}> = [];
  const readonlyNonSigners: Array<{pubkey: PublicKey; order: number}> = [];
  
  for (const [addrStr, meta] of accountMetadata) {
    if (meta.isSigner) {
      if (meta.isWritable) {
        writableSigners.push({ pubkey: meta.pubkey, order: meta.firstOrder });
      } else {
        readonlySigners.push({ pubkey: meta.pubkey, order: meta.firstOrder });
      }
    } else {
      if (meta.isWritable) {
        writableNonSigners.push({ pubkey: meta.pubkey, order: meta.firstOrder });
      } else {
        readonlyNonSigners.push({ pubkey: meta.pubkey, order: meta.firstOrder });
      }
    }
  }
  
  // Sort each category by first occurrence order
  writableSigners.sort((a, b) => a.order - b.order);
  readonlySigners.sort((a, b) => a.order - b.order);
  writableNonSigners.sort((a, b) => a.order - b.order);
  readonlyNonSigners.sort((a, b) => a.order - b.order);
  
  // Build staticAccountKeys in correct order
  const staticAccountKeys: PublicKey[] = [
    ...writableSigners.map(a => a.pubkey),
    ...readonlySigners.map(a => a.pubkey),
    ...writableNonSigners.map(a => a.pubkey),
    ...readonlyNonSigners.map(a => a.pubkey)
  ];
  
  // Build map for quick lookup
  const staticAccountKeyMap = new Map<string, number>();
  for (let i = 0; i < staticAccountKeys.length; i++) {
    staticAccountKeyMap.set(staticAccountKeys[i]!.toBase58(), i);
  }
  
  // Build addressTableLookups with explicit indexes
  const altWritableIndexes: number[] = [];
  const altReadonlyIndexes: number[] = [];
  
  for (const ix of instructions) {
    for (const meta of ix.keys) {
      const addrStr = meta.pubkey.toBase58();
      if (staticAccountKeyMap.has(addrStr)) continue;
      
      const altIdx = altAddressMap.get(addrStr);
      if (altIdx !== undefined) {
        if (meta.isWritable && !altWritableIndexes.includes(altIdx)) {
          altWritableIndexes.push(altIdx);
        } else if (!meta.isWritable && !altReadonlyIndexes.includes(altIdx)) {
          altReadonlyIndexes.push(altIdx);
        }
      }
    }
    
    // Check program ID
    const programIdStr = ix.programId.toBase58();
    if (!staticAccountKeyMap.has(programIdStr)) {
      const altIdx = altAddressMap.get(programIdStr);
      if (altIdx !== undefined) {
        if (!altReadonlyIndexes.includes(altIdx)) {
          altReadonlyIndexes.push(altIdx);
        }
      }
    }
  }
  
  // Sort indexes
  altWritableIndexes.sort((a, b) => a - b);
  altReadonlyIndexes.sort((a, b) => a - b);
  
  // Build mapping from lookup table index to final account index
  const altIndexToAccountIndex = new Map<number, number>();
  
  // Map writable indexes
  for (let i = 0; i < altWritableIndexes.length; i++) {
    const altIdx = altWritableIndexes[i]!;
    altIndexToAccountIndex.set(altIdx, staticAccountKeys.length + i);
  }
  
  // Map readonly indexes (after writable)
  for (let i = 0; i < altReadonlyIndexes.length; i++) {
    const altIdx = altReadonlyIndexes[i]!;
    const accountIdx = staticAccountKeys.length + altWritableIndexes.length + i;
    altIndexToAccountIndex.set(altIdx, accountIdx);
  }
  
  // Build compiled instructions
  const compiledInstructions: MessageCompiledInstruction[] = [];
  
  for (const ix of instructions) {
    // Find program ID index
    let programIdIndex: number;
    const programIdStr = ix.programId.toBase58();
    if (staticAccountKeyMap.has(programIdStr)) {
      programIdIndex = staticAccountKeyMap.get(programIdStr)!;
    } else {
      const altIdx = altAddressMap.get(programIdStr);
      if (altIdx === undefined) {
        throw new Error(`Program ID ${programIdStr} not found in staticAccountKeys or lookup table`);
      }
      const accountIndex = altIndexToAccountIndex.get(altIdx);
      if (accountIndex === undefined) {
        throw new Error(`Program ID ${programIdStr} lookup table index ${altIdx} not found in AddressTableLookups`);
      }
      programIdIndex = accountIndex;
    }
    
    // Build account indexes for this instruction
    const accountKeyIndexes: number[] = [];
    for (const meta of ix.keys) {
      const addrStr = meta.pubkey.toBase58();
      
      if (staticAccountKeyMap.has(addrStr)) {
        const staticIdx = staticAccountKeyMap.get(addrStr)!;
        accountKeyIndexes.push(staticIdx);
      } else {
        const altIdx = altAddressMap.get(addrStr);
        if (altIdx === undefined) {
          throw new Error(`Account ${addrStr} not found in staticAccountKeys or lookup table`);
        }
        const accountIndex = altIndexToAccountIndex.get(altIdx);
        if (accountIndex === undefined) {
          throw new Error(`Account ${addrStr} (ALT idx ${altIdx}) not found in AddressTableLookups`);
        }
        accountKeyIndexes.push(accountIndex);
      }
    }
    
    compiledInstructions.push({
      programIdIndex,
      accountKeyIndexes,
      data: Uint8Array.from(ix.data)
    });
  }
  
  // Build MessageHeader
  const numReadonlySignedAccounts = readonlySigners.length;
  const numReadonlyUnsignedAccounts = readonlyNonSigners.length;
  
  const header: MessageHeader = {
    numRequiredSignatures: allSigners.length,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts
  };
  
  // Build AddressTableLookups
  const addressTableLookups: MessageAddressTableLookup[] = [];
  if (altWritableIndexes.length > 0 || altReadonlyIndexes.length > 0) {
    addressTableLookups.push({
      accountKey: lookupTableAccount.key,
      writableIndexes: altWritableIndexes,
      readonlyIndexes: altReadonlyIndexes
    });
  }
  
  // Construct MessageV0 manually
  const messageV0 = new MessageV0({
    header,
    staticAccountKeys,
    recentBlockhash,
    compiledInstructions,
    addressTableLookups
  });
  
  return messageV0;
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

interface BatchTransferParams {
  connection: Connection;
  wallet: WalletContextState;
  transfers: Array<{
    originMint: string;
    poolId: string;
    proof: ProofResponse;
    nullifiers: readonly string[];
    outputCommitments: readonly string[];
    outputAmountCommitments: readonly string[];
  }>;
  batchProof: ProofResponse; // Combined batch proof
  batchPublicInputs: string[]; // Combined public inputs from batch proof (16 field elements for 2 transfers)
  keypair?: Keypair; // Optional keypair for signing VersionedTransaction
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
    // Check if this is wSOL (native SOL mint) and provide a helpful error message
    if (isNativeSol(originMint)) {
      throw new Error(
        'wSOL (Wrapped SOL) mint mapping is not registered in the mint catalog. ' +
        'wSOL registration requires factory authority. Please run the bootstrap script ' +
        'or contact the administrator to register wSOL. The native SOL mint address is: So11111111111111111111111111111111111111112. ' +
        'Note: The bootstrap script will attempt to auto-register wSOL, but it may require manual registration on some networks.'
      );
    }
    throw new Error(`Mint mapping account missing on chain for mint: ${originMint.toBase58()}`);
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
  
  // Calculate offset for pending_shield.active in PoolState
  // PoolState layout: discriminator(8) + pubkeys(32*6) + arrays + fields before pending_shield
  // Offset calculation:
  // 8 (discriminator) + 192 (6 pubkeys) + 32 (verifying_key_id) + 32 (verifying_key_hash) + 32 (current_root)
  // + 1024 (recent_roots) + 256 (recent_roots_timestamps) + 1 (roots_len) + 2 (fee_bps) + 1 (features)
  // + 32 (note_ledger) + 1 (note_ledger_bump) + 16 (protocol_fees) + 32 (hook_config) + 1 (hook_config_present)
  // + 1 (hook_config_bump) + 1 (bump) + 32 (twin_mint) + 1 (twin_mint_enabled) = 1697
  const PENDING_SHIELD_ACTIVE_OFFSET = 1697;
  
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
    
    let isActive = false;
    try {
      // Try decoding first
      const decoded = poolCoder.accounts.decode('PoolState', accountInfo.data) as {
        pendingShield?: { active?: number };
        pending_shield?: { active?: number };
      };
      const pendingShield = decoded.pendingShield ?? decoded.pending_shield;
      isActive = pendingShield?.active !== undefined && pendingShield.active !== 0;
    } catch (error) {
      // If decoding fails, read pending_shield.active byte directly from account data
      if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
        console.warn('[wrap] Failed to decode PoolState, reading pending_shield.active directly:', error);
      }
      
      // Read the active byte directly from account data
      const accountData = Buffer.from(accountInfo.data);
      if (accountData.length > PENDING_SHIELD_ACTIVE_OFFSET) {
        const activeByte = accountData[PENDING_SHIELD_ACTIVE_OFFSET];
        isActive = activeByte !== undefined && activeByte !== 0;
        if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
          console.info(`[wrap] Read pending_shield.active directly from offset ${PENDING_SHIELD_ACTIVE_OFFSET}: ${activeByte}`);
        }
      } else {
        // Account data too short - assume inactive (pool might not be initialized)
        isActive = false;
      }
    }
    
    if (!isActive) {
      if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
        console.info(`[wrap] pending_shield is inactive after ${attempts} attempts`);
      }
      return;
    }
    
    if (attempts % 10 === 0) {
      console.info(`[wrap] Waiting for pending_shield to be inactive (attempt ${attempts}/${maxAttempts})...`);
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
    // CRITICAL: Lookup table addresses must be in the EXACT same order as they appear in Shield instruction
    // This ensures compileToV0Message maps addresses correctly when compressing transactions.
    // Shield instruction order (from programs/pool/src/lib.rs):
    // 0: pool_state, 1: hook_config, 2: hook_whitelist, 3: nullifier_set, 4: commitment_tree,
    // 5: note_ledger, 6: vault_state, 7: vault_token_account, 8: depositor_token_account,
    // 9: twin_mint (optional, skip in lookup table), 10: verifier_program, 11: verifying_key,
    // 12: shield_claim, 13: payer (signer, skip in lookup table), 14: origin_mint, 15: mint_mapping,
    // 16: factory_state, 17: vault_program, 18: token_program, 19: system_program, 20: rent
    //
    // Note: vault_token_account and depositor_token_account are user-specific, so we can't include
    // them in the lookup table. We'll include all other accounts in order.
    const vaultTokenAccount = await getAssociatedTokenAddress(
      originMintKey,
      vaultState,
      true,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    const allAddresses = [
      poolState,              // 0
      hookConfig,             // 1
      hookWhitelist,          // 2
      nullifierSet,           // 3
      commitmentTreeKey,      // 4
      noteLedger,             // 5
      vaultState,             // 6
      // vault_token_account (7) - user-specific, skip
      // depositor_token_account (8) - user-specific, skip
      // twin_mint (9) - optional, skip
      VERIFIER_PROGRAM_ID,    // 10
      verifyingKey,           // 11
      shieldClaim,            // 12
      // payer (13) - signer, skip
      originMintKey,          // 14
      mintMappingKey,         // 15
      factoryState,           // 16
      VAULT_PROGRAM_ID,       // 17 - CRITICAL: Must come before token_program
      tokenProgramId,         // 18 - CRITICAL: Must come after vault_program
      SystemProgram.programId,// 19
      SYSVAR_RENT_PUBKEY      // 20
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

  let originMintKey = new PublicKey(params.originMint);
  
  // SOL HANDLING: Detect if user is trying to shield native SOL
  // If so, we need to wrap it to wSOL first, then shield the wSOL
  const isShieldingSOL = isNativeSol(originMintKey);
  let wsolTokenAccount: PublicKey | null = null;
  let actualShieldMint: PublicKey = originMintKey;
  
  if (isShieldingSOL) {
    console.log('[wrap] SOL detected - will wrap to wSOL before shielding');
    console.log('[wrap] Native SOL mint:', originMintKey.toBase58());
    
    // Use wSOL mint for the actual shield operation
    actualShieldMint = NATIVE_SOL_MINT;
    console.log('[wrap] Using wSOL mint for shield:', actualShieldMint.toBase58());
    
    // Get or create wSOL token account
    wsolTokenAccount = await getWrappedSolAccount(wallet.publicKey);
    console.log('[wrap] wSOL token account:', wsolTokenAccount.toBase58());
    
    // Always wrap the full amount (no need to check existing wSOL balance)
  }
  
  // Use actualShieldMint for all pool/account derivations (will be wSOL mint if SOL was detected)
  const poolState = new PublicKey(params.poolId);
  const commitmentTreeKey = deriveCommitmentTree(actualShieldMint);
  const nullifierSet = deriveNullifierSet(actualShieldMint);
  const noteLedger = deriveNoteLedger(actualShieldMint);
  const hookConfig = deriveHookConfig(actualShieldMint);
  const hookWhitelist = deriveHookWhitelist(actualShieldMint);
  const vaultState = deriveVaultState(actualShieldMint);
  const verifyingKey = deriveVerifyingKey();
  const shieldClaim = deriveShieldClaim(poolState);
  const factoryState = deriveFactoryState(); // Needed for lazy initialization
  const twinMintKey = params.twinMint ? new PublicKey(params.twinMint) : null;
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    actualShieldMint // Use actualShieldMint (wSOL if SOL was detected)
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

  // LAZY INITIALIZATION: Shield instruction uses init_if_needed on pool_state,
  // so it will automatically initialize the pool on first shield in the same transaction.
  // We don't need to check if pool exists - shield handles initialization automatically.
  // However, we still check to provide better error messages if there are other issues.
  const poolAccountInfo = await connection.getAccountInfo(poolState, 'confirmed');
  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey, 'confirmed');
  
  // If pool doesn't exist, shield will initialize it lazily via init_if_needed.
  // If pool exists but commitment tree is missing, that's an error state.
  if (poolAccountInfo && !commitmentTreeAccount) {
    throw new Error(
      'Commitment tree account missing even though pool is initialized. This is an inconsistent state - run repair tooling.'
    );
  }
  
  // CRITICAL: Program validates old_root against pool_state.current_root, not commitment tree root
  // Fetch root from pool_state if it exists, otherwise use default empty root
  let currentRootBytes: Uint8Array;
  if (poolAccountInfo) {
    // Pool exists - read current_root from pool_state
    const poolStateData = Buffer.from(poolAccountInfo.data);
    const CURRENT_ROOT_OFFSET = 8 + 32 * 8; // discriminator (8) + 6 pubkeys (32*6) + verifying_key_id (32) + verifying_key_hash (32)
    currentRootBytes = new Uint8Array(poolStateData.slice(CURRENT_ROOT_OFFSET, CURRENT_ROOT_OFFSET + 32));
  } else {
    // Pool doesn't exist - use default empty root for lazy initialization
    currentRootBytes = new Uint8Array(32);
  }
  
  // Still need treeState for other operations (e.g., nextIndex for depositId)
  let treeState;
  if (commitmentTreeAccount) {
    treeState = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
  } else {
    // Lazy initialization - use default root (empty tree)
    treeState = {
      currentRoot: currentRootBytes, // Use pool_state root if available
      roots: []
    };
  }
  const recipientKey = params.recipient ? new PublicKey(params.recipient) : wallet.publicKey;
  const depositId = BigInt(params.depositId);
  const blinding = BigInt(params.blinding);
  const amount = params.amount;

  const amountCommitmentBytes = await poseidonHashMany([amount, blinding]);

  // Determine which token program the mint uses
  // Check the actual shield mint (wSOL if SOL, otherwise original mint)
  const mintAccount = await connection.getAccountInfo(actualShieldMint, 'confirmed');
  if (!mintAccount) {
    throw new Error('Mint account not found');
  }
  const tokenProgramId = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) 
    ? TOKEN_2022_PROGRAM_ID 
    : TOKEN_PROGRAM_ID;

  // If shielding SOL, use wSOL mint and wSOL token account for deposit
  const vaultTokenAccount = await getAssociatedTokenAddress(
    actualShieldMint, // Use actualShieldMint (wSOL mint if SOL)
    vaultState,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // If shielding SOL, use wSOL token account directly, otherwise derive ATA
  const depositorTokenAccount = (isShieldingSOL && wsolTokenAccount) 
    ? wsolTokenAccount 
    : await getAssociatedTokenAddress(
        actualShieldMint,
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

  // SOL WRAPPING: Always wrap the full amount needed (don't check existing wSOL balance)
  if (isShieldingSOL && wsolTokenAccount) {
    console.log('[wrap] 🔄 Wrapping SOL to wSOL before shielding');
    console.log('[wrap] Amount to wrap:', amount.toString(), 'lamports');
    const wrapInstructions = await createWrapSolInstructions(
      wsolTokenAccount,
      amount,
      wallet.publicKey,
      connection
    );
    instructions.push(...wrapInstructions);
    console.log('[wrap] ✅ Added', wrapInstructions.length, 'wrap instructions');
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
        actualShieldMint, // Use actualShieldMint (wSOL if SOL)
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  
  // If shielding SOL, depositor account is wSOL account which should already exist or be created by wrap instructions
  // For non-SOL, create depositor account if needed
  if (!isShieldingSOL) {
    const depositorInfo = await connection.getAccountInfo(depositorTokenAccount);
    if (!depositorInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          depositorTokenAccount,
          wallet.publicKey,
          actualShieldMint,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }

  const decodedProof = decodeProofPayload(params.proof);
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[wrap] current root from pool_state', Buffer.from(currentRootBytes).toString('hex'));
    // eslint-disable-next-line no-console
    console.info('[wrap] old root field', Buffer.from(decodedProof.fields[0] ?? []).toString('hex'));
    if (decodedProof.fields[0]) {
      // eslint-disable-next-line no-console
      console.info('[wrap] old root field (canonical)', bytesLEToCanonicalHex(decodedProof.fields[0]));
      // eslint-disable-next-line no-console
      console.info('[wrap] pool_state root (canonical)', bytesLEToCanonicalHex(currentRootBytes));
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
    { pubkey: actualShieldMint, isSigner: false, isWritable: false }, // Use actualShieldMint (wSOL if SOL)
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
        
        // Try to sign VersionedTransaction with wallet adapter first
        if (wallet.signTransaction) {
          try {
            const signedVersionedTx = await wallet.signTransaction(shieldTransaction);
            shieldSignature = await connection.sendRawTransaction(signedVersionedTx.serialize(), {
              skipPreflight: false
            });
          } catch (signError: any) {
            console.warn('[wrap] Failed to sign VersionedTransaction with wallet adapter:', signError);
            // Fall through to try keypair or regular Transaction
          }
        }
        
        // If wallet adapter signing failed, try manual signing with keypair (for test scenarios)
        if (!shieldSignature) {
          let signerKeypair: Keypair | null = null;
          if (params.keypair) {
            signerKeypair = params.keypair;
          } else if ((wallet as any).secretKey) {
            // Wallet is already a Keypair
            signerKeypair = wallet as any;
          }
          
          if (signerKeypair) {
            try {
              shieldTransaction.sign([signerKeypair]);
              shieldSignature = await connection.sendRawTransaction(shieldTransaction.serialize(), {
                skipPreflight: false
              });
            } catch (keypairError: any) {
              // Check if this is a PendingShieldInFlight error - if so, throw it to trigger retry logic
              const { isPendingShieldError } = require('./errorHandler');
              if (isPendingShieldError(keypairError)) {
                throw keypairError; // Re-throw to trigger retry logic in catch block below
              }
              console.warn('[wrap] Failed to send signed VersionedTransaction:', keypairError);
            }
          }
        }
        
        // Can't sign VersionedTransaction - fall back to regular Transaction
          // BUT: If transaction is too large, we need to wait for pending shield or retry with VersionedTransaction
          if (!shieldSignature) {
            console.warn('[wrap] Cannot sign VersionedTransaction, falling back to regular Transaction (may exceed size limits)');
            
            let signerKeypair: Keypair | null = null;
            if (params.keypair) {
              signerKeypair = params.keypair;
            } else if ((wallet as any).secretKey) {
              signerKeypair = wallet as any;
            }
            
            const regularTx = new Transaction().add(...shieldInstructionSet);
            regularTx.feePayer = wallet.publicKey;
            regularTx.recentBlockhash = latestBlockhash.blockhash;
            
            // Sign for size check
            if (signerKeypair) {
              regularTx.partialSign(signerKeypair);
            }
            
            const txSize = regularTx.serialize().length;
            if (txSize > 1232) {
              // Transaction is too large - check if this is due to pending shield blocking VersionedTransaction
              // If so, throw an error that will be caught and trigger retry logic
              console.warn(`[wrap] Regular Transaction too large (${txSize} bytes > 1232). VersionedTransaction likely failed due to pending shield. Will retry.`);
              // Throw error to trigger retry - will be caught as PendingShieldInFlight if that's the cause
              throw new Error('Transaction too large for regular Transaction. VersionedTransaction failed, likely due to pending shield.');
            }
            
            // Recreate transaction for sending (wallet.sendTransaction will sign it)
            const txForSending = new Transaction().add(...shieldInstructionSet);
            txForSending.feePayer = wallet.publicKey;
            txForSending.recentBlockhash = latestBlockhash.blockhash;
            
            try {
              shieldSignature = await wallet.sendTransaction(txForSending, connection, {
                skipPreflight: false
              });
            } catch (txError: any) {
              // Check if this is a PendingShieldInFlight error - if so, throw it to trigger retry logic
              const { isPendingShieldError } = require('./errorHandler');
              if (isPendingShieldError(txError)) {
                throw txError; // Re-throw to trigger retry logic in catch block below
              }
              throw txError; // Re-throw other errors
            }
          }
      } else {
        // Fall back to regular Transaction if ALT not available
        const regularTx = new Transaction().add(...shieldInstructionSet);
        regularTx.feePayer = wallet.publicKey;
        regularTx.recentBlockhash = latestBlockhash.blockhash;
        
        // Get keypair for signing (needed for size check)
        let signerKeypair: Keypair | null = null;
        if (params.keypair) {
          signerKeypair = params.keypair;
        } else if ((wallet as any).secretKey) {
          signerKeypair = wallet as any;
        }
        
        // Sign for size check
        if (signerKeypair) {
          regularTx.partialSign(signerKeypair);
        }
        
        const txSize = regularTx.serialize().length;
        const maxTxSize = 1232;
        if (txSize > maxTxSize) {
          // Transaction too large - try with skipPreflight for slightly oversized transactions
          // For first shield (before lookup table exists), allow up to 1400 bytes
          if (txSize > 1400) {
            // Transaction is way too large - cannot proceed without ALT
            throw new Error(`Transaction too large (${txSize} bytes > 1232). Address Lookup Table required but not available.`);
          }
          console.warn(`[wrap] Transaction slightly oversized (${txSize} bytes), using skipPreflight: true`);
        }
        
        // Recreate transaction for sending (wallet.sendTransaction will sign it)
        const txForSending = new Transaction().add(...shieldInstructionSet);
        txForSending.feePayer = wallet.publicKey;
        txForSending.recentBlockhash = latestBlockhash.blockhash;
        
        try {
          shieldSignature = await wallet.sendTransaction(txForSending, connection, {
            skipPreflight: txSize > maxTxSize // Use skipPreflight for oversized transactions
          });
        } catch (txError: any) {
          // Check if this is a PendingShieldInFlight error - if so, throw it to trigger retry logic
          const { isPendingShieldError } = require('./errorHandler');
          if (isPendingShieldError(txError)) {
            throw txError; // Re-throw to trigger retry logic in catch block below
          }
          throw txError; // Re-throw other errors
        }
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
        console.warn(`[wrap] Shield failed with PendingShieldInFlight (attempt ${shieldAttempts}/${maxShieldAttempts}), waiting for pending shield and shield claim to clear...`);
        // Wait for both pending shield and shield claim to become inactive/stale
        // The shield instruction checks both: if there's a valid active shield claim, it rejects
        try {
          // Wait for pending shield to become inactive
          await waitForPendingShieldInactive(connection, poolState, 30000); // Wait up to 30 seconds
          
          // Check shield claim status - if it exists and is active, check if it's stale
          // The shield instruction will automatically deactivate stale shield claims (old_root mismatch)
          // If the shield claim is valid (old_root matches current_root), it means a shield is in progress
          // and we should wait for it to complete. If it's stale, we can proceed.
          console.info('[wrap] Checking shield claim status...');
          let shieldClaimStale = false;
          try {
            const claimDecoded = await fetchShieldClaimState(connection, shieldClaim);
            const claimState = claimDecoded as any; // Cast to access old_root which may be in different formats
            if (claimState.status !== SHIELD_CLAIM_STATUS.INACTIVE) {
              // Shield claim is active - check if it's stale by comparing old_root to current_root
              const treeAccount = await connection.getAccountInfo(commitmentTreeKey);
              if (treeAccount) {
                const treeState = decodeCommitmentTree(new Uint8Array(treeAccount.data));
                const currentRootBytes = treeState.currentRoot;
                
                // Get old_root from decoded claim - it might be in different formats
                const claimOldRootRaw = claimState.old_root || claimState.oldRoot;
                if (claimOldRootRaw) {
                  // Convert to Uint8Array regardless of input format
                  const claimOldRootBytes = claimOldRootRaw instanceof Uint8Array
                    ? claimOldRootRaw
                    : Buffer.isBuffer(claimOldRootRaw)
                    ? new Uint8Array(claimOldRootRaw)
                    : Array.isArray(claimOldRootRaw)
                    ? new Uint8Array(claimOldRootRaw)
                    : claimOldRootRaw instanceof Object && Object.values(claimOldRootRaw).length === 32
                    ? new Uint8Array(Object.values(claimOldRootRaw) as number[])
                    : null;
                  
                  if (claimOldRootBytes && claimOldRootBytes.length === currentRootBytes.length) {
                    // Compare old_root from claim to current_root from tree
                    const claimOldRootMatches = claimOldRootBytes.every((byte, idx) => byte === currentRootBytes[idx]);
                    if (!claimOldRootMatches) {
                      // Claim is stale - shield instruction will deactivate it
                      console.info('[wrap] Shield claim is stale (old_root mismatch), shield instruction will deactivate it');
                      shieldClaimStale = true;
                    } else {
                      // Claim is valid - check if it's expired
                      const now = Math.floor(Date.now() / 1000); // Current Unix timestamp in seconds
                      const expiresAt = claimState.expires_at 
                        ? (typeof claimState.expires_at === 'bigint' 
                            ? Number(claimState.expires_at) 
                            : claimState.expires_at)
                        : null;
                      
                      if (expiresAt && now > expiresAt) {
                        // Claim is expired - shield instruction will deactivate it
                        console.info(`[wrap] Shield claim is expired (expired at ${expiresAt}, now ${now}), shield instruction will deactivate it`);
                        shieldClaimStale = true;
                      } else {
                        // Claim is valid and not expired - wait for it to complete, but with a timeout
                        console.info(`[wrap] Shield claim is valid (old_root matches${expiresAt ? `, expires at ${expiresAt}` : ''}), waiting for shield operation to complete...`);
                        // Wait longer for stuck operations - but not too long
                        await sleep(10000); // Wait 10 seconds for shield operation to complete
                        // After waiting, check again if claim is still active - if so, it might be stuck
                        try {
                          const recheckClaim = await fetchShieldClaimState(connection, shieldClaim);
                          if (recheckClaim.status !== SHIELD_CLAIM_STATUS.INACTIVE) {
                            console.warn('[wrap] Shield claim still active after waiting - claim appears to be stuck');
                            console.warn('[wrap] The shield instruction will reject new shields until the claim is finalized or expires');
                            console.warn('[wrap] Stuck claims will auto-expire after 30 seconds');
                            // Don't proceed - the shield instruction will still reject valid claims
                            // Instead, throw an error to inform the user
                            throw new Error(
                              'A previous shield operation appears to be stuck. The shield claim is valid but not finalized. ' +
                              'Please wait for the claim to expire (30 seconds). ' +
                              `Claim expires at: ${expiresAt ? new Date(expiresAt * 1000).toISOString() : 'unknown'}`
                            );
                          }
                        } catch (e) {
                          // Claim might have been deactivated - proceed
                          shieldClaimStale = true;
                        }
                      }
                    }
                  } else {
                    console.warn('[wrap] Could not parse old_root from shield claim, waiting anyway...');
                    await sleep(3000);
                  }
                } else {
                  console.warn('[wrap] Shield claim has no old_root field, waiting anyway...');
                  await sleep(3000);
                }
              }
            } else {
              console.info('[wrap] Shield claim is inactive');
            }
          } catch (claimError) {
            // Shield claim doesn't exist or can't be read - this is fine, proceed
            console.info('[wrap] Shield claim not found or can\'t be read, proceeding...');
            shieldClaimStale = true;
          }
          
          console.info('[wrap] Pending shield cleared, refreshing root and regenerating proof...');
          // Refresh root after waiting - it may have changed if a shield completed
          const refreshedTreeAccount = await connection.getAccountInfo(commitmentTreeKey);
          if (refreshedTreeAccount) {
            const refreshedTreeState = decodeCommitmentTree(new Uint8Array(refreshedTreeAccount.data));
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
        } catch (waitError) {
          console.warn('[wrap] Error while waiting for pending shield/claim to clear, but retrying anyway (shield instruction may clear stale shields)...', waitError);
          await sleep(3000); // Longer wait before retry
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

  // Check claim status before calling shield_check_invariant
  // Handle all possible statuses including LEDGER_COMPLETE
  claimState = await fetchShieldClaimState(connection, shieldClaim);
  
  // Prepare invariant instructions (needed for retry logic later)
  const invariantInstructions: TransactionInstruction[] = [];
  if (resolvedComputeLimit > 0) {
    invariantInstructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedComputeLimit }));
  }
  invariantInstructions.push(checkInvariantInstruction);
  
  // Finalize the shield claim by calling shield_finalize_tree first if needed, then shield_check_invariant
  // STATUS_LEDGER_COMPLETE (4) means ledger is complete but tree finalization may still be needed
  // If in LEDGER_COMPLETE status, we may need to call shield_finalize_tree first
  let invariantSignature: string | null = null;
  
  // If status is LEDGER_COMPLETE, we may need to finalize tree first
  if (claimState.status === SHIELD_CLAIM_STATUS.LEDGER_COMPLETE) {
    console.info('[wrap] Shield claim is in LEDGER_COMPLETE status, calling shield_finalize_tree first...');
    // Try finalize_tree to transition to AWAITING_INVARIANT
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
    console.info('[wrap] shield_finalize_tree completed for LEDGER_COMPLETE status, signature:', finalizeTreeSignature);
    
    // Recheck status after finalize_tree
    await sleep(500);
    claimState = await fetchShieldClaimState(connection, shieldClaim);
  }
  
  if (claimState.status === SHIELD_CLAIM_STATUS.AWAITING_INVARIANT || 
      claimState.status === SHIELD_CLAIM_STATUS.AWAITING_LEDGER ||
      claimState.status === SHIELD_CLAIM_STATUS.LEDGER_COMPLETE) {
    const invariantBlockhash = await connection.getLatestBlockhash('confirmed');
    const invariantTransaction = new Transaction().add(...invariantInstructions);
    invariantTransaction.feePayer = wallet.publicKey;
    invariantTransaction.recentBlockhash = invariantBlockhash.blockhash;

    invariantSignature = await wallet.sendTransaction(invariantTransaction, connection, {
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
  } else if (claimState.status === SHIELD_CLAIM_STATUS.INACTIVE) {
    console.info('[wrap] Shield claim already inactive, no invariant check needed');
    invariantSignature = shieldSignature; // Return shield signature if already inactive
  } else if (claimState.status === SHIELD_CLAIM_STATUS.PENDING_TREE) {
    console.warn('[wrap] Shield claim in PENDING_TREE status, should have been finalized by now. Attempting finalize_tree...');
    // Try finalize_tree to transition to next state
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
    console.info('[wrap] Retried shield_finalize_tree for PENDING_TREE status, signature:', finalizeTreeSignature);
    
    // Recheck status and try invariant check
    await sleep(500);
    claimState = await fetchShieldClaimState(connection, shieldClaim);
    
    if (claimState.status === SHIELD_CLAIM_STATUS.AWAITING_INVARIANT || 
        claimState.status === SHIELD_CLAIM_STATUS.AWAITING_LEDGER) {
      const invariantBlockhash = await connection.getLatestBlockhash('confirmed');
      const invariantTransaction = new Transaction().add(...invariantInstructions);
      invariantTransaction.feePayer = wallet.publicKey;
      invariantTransaction.recentBlockhash = invariantBlockhash.blockhash;

      invariantSignature = await wallet.sendTransaction(invariantTransaction, connection, {
        skipPreflight: false
      });

      await waitForSignatureConfirmation(
        connection,
        invariantSignature,
        invariantBlockhash.blockhash,
        invariantBlockhash.lastValidBlockHeight
      );
      console.info('[wrap] shield invariant signature after finalize_tree retry', invariantSignature);
    } else {
      invariantSignature = shieldSignature;
    }
  } else {
    console.warn(`[wrap] Shield claim in unexpected status (${claimState.status}), attempting invariant check anyway`);
    // Try calling invariant check anyway - it might handle other statuses
    const invariantBlockhash = await connection.getLatestBlockhash('confirmed');
    const invariantTransaction = new Transaction().add(...invariantInstructions);
    invariantTransaction.feePayer = wallet.publicKey;
    invariantTransaction.recentBlockhash = invariantBlockhash.blockhash;

    invariantSignature = await wallet.sendTransaction(invariantTransaction, connection, {
      skipPreflight: false
    });

    await waitForSignatureConfirmation(
      connection,
      invariantSignature,
      invariantBlockhash.blockhash,
      invariantBlockhash.lastValidBlockHeight
    );
    console.info('[wrap] shield invariant signature (unexpected status)', invariantSignature);
  }

  // CRITICAL: Verify that the shield claim is actually deactivated after finalization
  // If it's not inactive, we need to wait or retry finalization
  let finalClaimState = await fetchShieldClaimState(connection, shieldClaim);
  const maxFinalizationWait = 10000; // Wait up to 10 seconds for claim to deactivate
  const startFinalizationWait = Date.now();
  
  while (finalClaimState.status !== SHIELD_CLAIM_STATUS.INACTIVE && 
         (Date.now() - startFinalizationWait) < maxFinalizationWait) {
    console.info(`[wrap] Shield claim still active (status: ${finalClaimState.status}), waiting for deactivation...`);
    await sleep(1000);
    finalClaimState = await fetchShieldClaimState(connection, shieldClaim);
    
    // If claim is still active, try calling finalize_tree and check_invariant again
    // Sometimes the status transitions require multiple calls
    if (finalClaimState.status !== SHIELD_CLAIM_STATUS.INACTIVE) {
      try {
        // Try finalize_tree again if status indicates it's needed
        if (finalClaimState.status === SHIELD_CLAIM_STATUS.PENDING_TREE || 
            finalClaimState.status === SHIELD_CLAIM_STATUS.AWAITING_LEDGER ||
            finalClaimState.status === SHIELD_CLAIM_STATUS.AWAITING_INVARIANT ||
            finalClaimState.status === SHIELD_CLAIM_STATUS.LEDGER_COMPLETE) {
          const retryTreeBlockhash = await connection.getLatestBlockhash('confirmed');
          const retryTreeTransaction = new Transaction().add(...finalizeTreeInstructions);
          retryTreeTransaction.feePayer = wallet.publicKey;
          retryTreeTransaction.recentBlockhash = retryTreeBlockhash.blockhash;
          const retryTreeSignature = await wallet.sendTransaction(retryTreeTransaction, connection, {
            skipPreflight: false
          });
          await waitForSignatureConfirmation(
            connection,
            retryTreeSignature,
            retryTreeBlockhash.blockhash,
            retryTreeBlockhash.lastValidBlockHeight
          );
          console.info('[wrap] Retried shield_finalize_tree, signature:', retryTreeSignature);
        }
        
        // Try check_invariant again if status indicates it's needed
        if (finalClaimState.status === SHIELD_CLAIM_STATUS.AWAITING_INVARIANT ||
            finalClaimState.status === SHIELD_CLAIM_STATUS.AWAITING_LEDGER ||
            finalClaimState.status === SHIELD_CLAIM_STATUS.LEDGER_COMPLETE) {
          const retryInvariantBlockhash = await connection.getLatestBlockhash('confirmed');
          const retryInvariantTransaction = new Transaction().add(...invariantInstructions);
          retryInvariantTransaction.feePayer = wallet.publicKey;
          retryInvariantTransaction.recentBlockhash = retryInvariantBlockhash.blockhash;
          const retryInvariantSignature = await wallet.sendTransaction(retryInvariantTransaction, connection, {
            skipPreflight: false
          });
          await waitForSignatureConfirmation(
            connection,
            retryInvariantSignature,
            retryInvariantBlockhash.blockhash,
            retryInvariantBlockhash.lastValidBlockHeight
          );
          console.info('[wrap] Retried shield_check_invariant, signature:', retryInvariantSignature);
        }
        
        // Check status again after retry
        await sleep(500);
        finalClaimState = await fetchShieldClaimState(connection, shieldClaim);
      } catch (retryError) {
        console.warn('[wrap] Error retrying finalization, will continue waiting:', retryError);
      }
    }
  }
  
  if (finalClaimState.status !== SHIELD_CLAIM_STATUS.INACTIVE) {
    console.warn(`[wrap] Shield claim still active after finalization (status: ${finalClaimState.status}). This may indicate a program bug or the claim needs to expire (30 seconds).`);
    console.warn('[wrap] The claim will auto-expire in 30 seconds if stuck. Shield operations may be blocked until then.');
    // Don't throw - the shield transaction succeeded, just the finalization isn't completing
    // The claim will expire after 30 seconds anyway
  } else {
    console.info('[wrap] Shield claim successfully deactivated after finalization');
  }

  // Log success for SOL shielding
  if (isShieldingSOL) {
    console.log('[wrap] ✅ Successfully shielded SOL → wSOL → zSOL');
    console.log('[wrap] Transaction signature:', invariantSignature || shieldSignature);
  }

  return invariantSignature || shieldSignature;
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
  
  // SOL HANDLING: Detect if unshielding to native SOL (wSOL)
  // If so, we'll need to unwrap wSOL to native SOL after unshield
  const isUnshieldingToSOL = isNativeSol(destinationMint);
  let wsolTokenAccountForUnwrap: PublicKey | null = null;
  
  if (isUnshieldingToSOL) {
    console.log('[unwrap] ⚡ SOL destination detected - will unwrap wSOL to SOL after unshield');
    console.log('[unwrap] Destination is native SOL mint (wSOL)');
    
    // Get wSOL token account (destination account will receive wSOL from unshield)
    wsolTokenAccountForUnwrap = destinationKey.equals(wallet.publicKey)
      ? await getWrappedSolAccount(destinationKey) // If destination is wallet, use wallet's wSOL account
      : await getWrappedSolAccount(destinationKey); // Otherwise use destination's wSOL account
    
    console.log('[unwrap] wSOL token account for unwrap:', wsolTokenAccountForUnwrap.toBase58());
    console.log('[unwrap] Destination wallet:', destinationKey.toBase58());
  }
  
  const destinationTokenProgram = redeemToTwin ? TOKEN_2022_PROGRAM_ID : originTokenProgram;
  const destinationTokenAccount = await getAssociatedTokenAddress(
    destinationMint, // Will be wSOL mint if unshielding to SOL
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
  
  // SOL UNWRAPPING: If unshielding to SOL, unwrap wSOL to native SOL
  if (isUnshieldingToSOL && wsolTokenAccountForUnwrap) {
    console.log('[unwrap] 🔄 Unshielding to SOL complete, now unwrapping wSOL to native SOL');
    
    try {
      // Always unwrap wSOL to native SOL after unshield
      // Create unwrap instruction
      const unwrapInstruction = createUnwrapSolInstruction(
        wsolTokenAccountForUnwrap,
        destinationKey // Owner who will receive native SOL
      );
      
      // Send unwrap transaction
      const unwrapBlockhash = await connection.getLatestBlockhash('confirmed');
      const unwrapTransaction = new Transaction().add(unwrapInstruction);
      unwrapTransaction.feePayer = wallet.publicKey;
      unwrapTransaction.recentBlockhash = unwrapBlockhash.blockhash;
      
      console.log('[unwrap] 💰 Unwrapping wSOL to native SOL');
      const unwrapSignature = await wallet.sendTransaction(unwrapTransaction, connection, {
        skipPreflight: false
      });
      
      await waitForSignatureConfirmation(
        connection,
        unwrapSignature,
        unwrapBlockhash.blockhash,
        unwrapBlockhash.lastValidBlockHeight
      );
      
      console.log('[unwrap] ✅ Successfully unwrapped wSOL to native SOL');
      console.log('[unwrap] ✅ Complete flow: zSOL → wSOL → SOL');
      console.log('[unwrap] Unwrap signature:', unwrapSignature);
      
      return unwrapSignature; // Return unwrap signature as it's the final transaction
    } catch (unwrapError: any) {
      console.error('[unwrap] ❌ Failed to unwrap wSOL to SOL:', unwrapError);
      console.error('[unwrap] ⚠️ Unshield succeeded but unwrap failed - user has wSOL instead of SOL');
      // Don't throw - unshield succeeded, just unwrap failed
      // User will have wSOL instead of SOL, but the unshield was successful
    }
  }
  
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

export async function batchTransfer(params: BatchTransferParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const payer = wallet.publicKey;
  
  if (params.transfers.length < 2 || params.transfers.length > 10) {
    throw new Error('Batch transfer requires 2-10 transfers');
  }
  
  // For now, support exactly 2 transfers (matches circuit)
  if (params.transfers.length !== 2) {
    throw new Error('Currently only 2 transfers are supported (circuit limitation)');
  }
  
  // Validate all transfers have matching commitment counts
  for (const transfer of params.transfers) {
    if (transfer.outputCommitments.length !== transfer.outputAmountCommitments.length) {
      throw new Error(`Transfer ${transfer.originMint}: Output commitment set mismatch`);
    }
  }
  
  // Derive accounts for first pool (explicit in instruction)
  const originMint0 = new PublicKey(params.transfers[0]!.originMint);
  const poolState0Key = new PublicKey(params.transfers[0]!.poolId);
  const commitmentTree0Key = deriveCommitmentTree(originMint0);
  const nullifierSet0Key = deriveNullifierSet(originMint0);
  const noteLedger0Key = deriveNoteLedger(originMint0);
  const { key: mintMapping0Key, decoded: mintMapping0 } = await fetchMintMappingAccount(
    connection,
    originMint0
  );
  ensureMintActive(mintMapping0);
  
  // Derive accounts for second pool (via remaining_accounts)
  const originMint1 = new PublicKey(params.transfers[1]!.originMint);
  const poolState1Key = new PublicKey(params.transfers[1]!.poolId);
  const commitmentTree1Key = deriveCommitmentTree(originMint1);
  const nullifierSet1Key = deriveNullifierSet(originMint1);
  const noteLedger1Key = deriveNoteLedger(originMint1);
  const { key: mintMapping1Key, decoded: mintMapping1 } = await fetchMintMappingAccount(
    connection,
    originMint1
  );
  ensureMintActive(mintMapping1);
  
  const verifyingKey = deriveVerifyingKey();
  
  // Extract roots from batch public inputs
  // Batch structure: [old_root_0, new_root_0, nullifier_0_0, nullifier_1_0, output_commitment_0_0, output_commitment_1_0, mint_id_0, pool_id_0,
  //                   old_root_1, new_root_1, nullifier_0_1, nullifier_1_1, output_commitment_0_1, output_commitment_1_1, mint_id_1, pool_id_1]
  if (params.batchPublicInputs.length !== 16) {
    throw new Error(`Invalid batch public inputs length: expected 16, got ${params.batchPublicInputs.length}`);
  }
  
  const oldRoot0Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[0]!));
  const newRoot0Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[1]!));
  const oldRoot1Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[8]!));
  const newRoot1Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[9]!));
  
  // OPTIMIZATION: Only include 1 output in TransferArgs when second output is zero (saves 64 bytes per transfer)
  // Check if second output_amount_commitment is all zeros (indicates zero output)
  const isSecondOutputZero0 = params.transfers[0]!.outputAmountCommitments.length >= 2 && 
    Buffer.from(canonicalHexToBytesLE(canonicalizeHex(params.transfers[0]!.outputAmountCommitments[1]!))).every(b => b === 0);
  const isSecondOutputZero1 = params.transfers[1]!.outputAmountCommitments.length >= 2 && 
    Buffer.from(canonicalHexToBytesLE(canonicalizeHex(params.transfers[1]!.outputAmountCommitments[1]!))).every(b => b === 0);
  
  // Optimize output arrays - only include first output if second is zero
  const outputCommitments0 = isSecondOutputZero0 
    ? params.transfers[0]!.outputCommitments.slice(0, 1)
    : params.transfers[0]!.outputCommitments;
  const outputAmountCommitments0 = isSecondOutputZero0
    ? params.transfers[0]!.outputAmountCommitments.slice(0, 1)
    : params.transfers[0]!.outputAmountCommitments;
    
  const outputCommitments1 = isSecondOutputZero1
    ? params.transfers[1]!.outputCommitments.slice(0, 1)
    : params.transfers[1]!.outputCommitments;
  const outputAmountCommitments1 = isSecondOutputZero1
    ? params.transfers[1]!.outputAmountCommitments.slice(0, 1)
    : params.transfers[1]!.outputAmountCommitments;
  
  if (isSecondOutputZero0) {
    console.log(`[batchTransfer] Transfer 0: Optimizing away zero second output (saves 64 bytes)`);
  }
  if (isSecondOutputZero1) {
    console.log(`[batchTransfer] Transfer 1: Optimizing away zero second output (saves 64 bytes)`);
  }
  
  // Create TransferArgs for each transfer
  const transferArgs0 = {
    old_root: Array.from(oldRoot0Bytes),
    new_root: Array.from(newRoot0Bytes),
    nullifiers: encodeFieldVector(params.transfers[0]!.nullifiers, 'nullifiers'),
    output_commitments: encodeFieldVector(outputCommitments0, 'output_commitments'),
    output_amount_commitments: encodeFieldVector(outputAmountCommitments0, 'output_amount_commitments'),
    proof: [], // Empty Vec<u8> - batch proof used instead (program ignores this field in batch mode, saves 192 bytes)
    public_inputs: [] // Empty Vec<u8> - batch public inputs used instead (program ignores this field in batch mode, saves 64 bytes)
  };
  
  const transferArgs1 = {
    old_root: Array.from(oldRoot1Bytes),
    new_root: Array.from(newRoot1Bytes),
    nullifiers: encodeFieldVector(params.transfers[1]!.nullifiers, 'nullifiers'),
    output_commitments: encodeFieldVector(outputCommitments1, 'output_commitments'),
    output_amount_commitments: encodeFieldVector(outputAmountCommitments1, 'output_amount_commitments'),
    proof: [], // Empty Vec<u8> - batch proof used instead (program ignores this field in batch mode, saves 192 bytes)
    public_inputs: [] // Empty Vec<u8> - batch public inputs used instead (program ignores this field in batch mode, saves 64 bytes)
  };
  
  // Create BatchTransferArgs
  // Convert batch proof to Buffer
  const batchProofBytes = Buffer.from(params.batchProof.proof, 'base64');
  
  // Serialize batch public inputs (16 field elements = 16 × 32 = 512 bytes)
  const batchPublicInputsBytes = Buffer.concat(
    params.batchPublicInputs.map(input => canonicalHexToBytesLE(canonicalizeHex(input)))
  );
  
  const batchTransferArgs = {
    transfers: [transferArgs0, transferArgs1],
    proof: Array.from(batchProofBytes), // Array format for Anchor Vec<u8>
    public_inputs: Array.from(batchPublicInputsBytes) // Array format for Anchor Vec<u8>
  };
  
  const instructions: TransactionInstruction[] = [];
  
  // Add compute budget
  const computeLimitEnv =
    process.env.BATCH_TRANSFER_COMPUTE_UNIT_LIMIT ??
    process.env.TRANSFER_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT;
  const resolvedLimit = (() => {
    if (computeLimitEnv !== undefined) {
      const parsed = Number(computeLimitEnv);
      if (!Number.isNaN(parsed)) {
        return Math.max(parsed, 0);
      }
    }
    return 1_200_000; // Higher limit for batch operations
  })();
  if (resolvedLimit > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedLimit }));
  }
  
  // Build batch_private_transfer instruction
  // Account order: pool_state_0, nullifier_set_0, commitment_tree_0, note_ledger_0, mint_mapping_0,
  //                verifier_program, verifying_key, payer, system_program, rent,
  //                remaining_accounts: pool_state_1, nullifier_set_1, commitment_tree_1, note_ledger_1, mint_mapping_1
  const instructionKeys = [
    { pubkey: poolState0Key, isSigner: false, isWritable: true },
    { pubkey: nullifierSet0Key, isSigner: false, isWritable: true },
    { pubkey: commitmentTree0Key, isSigner: false, isWritable: true },
    { pubkey: noteLedger0Key, isSigner: false, isWritable: true },
    { pubkey: mintMapping0Key, isSigner: false, isWritable: false },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add second pool accounts as remaining_accounts
  instructionKeys.push(
    { pubkey: poolState1Key, isSigner: false, isWritable: true },
    { pubkey: nullifierSet1Key, isSigner: false, isWritable: true },
    { pubkey: commitmentTree1Key, isSigner: false, isWritable: true },
    { pubkey: noteLedger1Key, isSigner: false, isWritable: true },
    { pubkey: mintMapping1Key, isSigner: false, isWritable: false }
  );
  
  // Encode instruction data - use full manual Borsh serialization to support empty Vec<u8>
  let instructionData: Buffer;
  try {
    instructionData = poolCoder.instruction.encode('batch_private_transfer', { args: batchTransferArgs });
  } catch (encodeError: any) {
    // Fallback to full manual Borsh serialization (bypasses Anchor encoder completely)
    console.warn('[batchTransfer] Anchor encoding failed, using full manual Borsh serialization:', encodeError.message);
    
    // Get discriminator for batch_private_transfer instruction
    const ixLayouts = (poolCoder.instruction as unknown as { ixLayouts?: Map<string, { discriminator: number[]; layout: any }> }).ixLayouts?.get('batch_private_transfer');
    if (!ixLayouts) {
      throw new Error('batch_private_transfer instruction layout not found in IDL');
    }
    const { discriminator } = ixLayouts;
    const discriminatorBuffer = Buffer.from(discriminator);
    
    // Manually serialize BatchTransferArgs using Borsh format
    // Structure: Vec<TransferArgs> + Vec<u8> (proof) + Vec<u8> (public_inputs)
    const parts: Buffer[] = [];
    
    // 1. Serialize transfers: Vec<TransferArgs> (length prefix + items)
    const transfersLength = Buffer.allocUnsafe(4);
    transfersLength.writeUInt32LE(batchTransferArgs.transfers.length, 0);
    parts.push(transfersLength);
    
    // Serialize each TransferArgs
    for (const transfer of batchTransferArgs.transfers) {
      // old_root: [u8; 32]
      parts.push(Buffer.from(transfer.old_root));
      
      // new_root: [u8; 32]
      parts.push(Buffer.from(transfer.new_root));
      
      // nullifiers: Vec<[u8; 32]>
      const nullifiersLength = Buffer.allocUnsafe(4);
      nullifiersLength.writeUInt32LE(transfer.nullifiers.length, 0);
      parts.push(nullifiersLength);
      for (const nullifier of transfer.nullifiers) {
        parts.push(Buffer.from(nullifier));
      }
      
      // output_commitments: Vec<[u8; 32]>
      const outputCommitmentsLength = Buffer.allocUnsafe(4);
      outputCommitmentsLength.writeUInt32LE(transfer.output_commitments.length, 0);
      parts.push(outputCommitmentsLength);
      for (const commitment of transfer.output_commitments) {
        parts.push(Buffer.from(commitment));
      }
      
      // output_amount_commitments: Vec<[u8; 32]>
      const outputAmountCommitmentsLength = Buffer.allocUnsafe(4);
      outputAmountCommitmentsLength.writeUInt32LE(transfer.output_amount_commitments.length, 0);
      parts.push(outputAmountCommitmentsLength);
      for (const amountCommitment of transfer.output_amount_commitments) {
        parts.push(Buffer.from(amountCommitment));
      }
      
      // proof: Vec<u8> (dummy - can be empty)
      const proofLength = Buffer.allocUnsafe(4);
      proofLength.writeUInt32LE(transfer.proof.length, 0);
      parts.push(proofLength);
      if (transfer.proof.length > 0) {
        parts.push(Buffer.from(transfer.proof));
      }
      
      // public_inputs: Vec<u8> (dummy - can be empty)
      const publicInputsLength = Buffer.allocUnsafe(4);
      publicInputsLength.writeUInt32LE(transfer.public_inputs.length, 0);
      parts.push(publicInputsLength);
      if (transfer.public_inputs.length > 0) {
        parts.push(Buffer.from(transfer.public_inputs));
      }
    }
    
    // 2. Serialize batch proof: Vec<u8>
    const batchProofLength = Buffer.allocUnsafe(4);
    batchProofLength.writeUInt32LE(batchTransferArgs.proof.length, 0);
    parts.push(batchProofLength);
    parts.push(Buffer.from(batchTransferArgs.proof));
    
    // 3. Serialize batch public_inputs: Vec<u8>
    const batchPublicInputsLength = Buffer.allocUnsafe(4);
    batchPublicInputsLength.writeUInt32LE(batchTransferArgs.public_inputs.length, 0);
    parts.push(batchPublicInputsLength);
    parts.push(Buffer.from(batchTransferArgs.public_inputs));
    
    // Combine all parts
    const batchTransferArgsBytes = Buffer.concat(parts);
    console.log(`[batchTransfer] Manually serialized BatchTransferArgs: ${batchTransferArgsBytes.length} bytes`);
    
    // Construct instruction data: discriminator + BatchTransferArgs
    instructionData = Buffer.concat([discriminatorBuffer, batchTransferArgsBytes]);
    console.log(`[batchTransfer] Successfully manually serialized instruction: ${instructionData.length} bytes`);
  }
  
  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: instructionKeys,
      data: instructionData
    })
  );
  
  // Use VersionedTransaction with lookup tables for account compression
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  
  // Collect all accounts for lookup table compression
  const allAccountsSet = new Set<string>();
  const allAccounts: PublicKey[] = [];
  
  const addAccount = (pubkey: PublicKey) => {
    const addr = pubkey.toBase58();
    if (!allAccountsSet.has(addr)) {
      allAccountsSet.add(addr);
      allAccounts.push(pubkey);
    }
  };
  
  // Add all accounts from instruction keys (except signers which must be direct)
  for (const key of instructionKeys) {
    if (!key.isSigner) {
      addAccount(key.pubkey);
    }
  }
  
  // Add pool program ID
  addAccount(POOL_PROGRAM_ID);
  
  console.log(`[batchTransfer] Collected ${allAccounts.length} unique accounts for compression`);
  
  // Get lookup tables from mint mappings (reuse already fetched mint mappings)
  // mintMapping0 and mintMapping1 are already fetched above
  
  const lookupTables: AddressLookupTableAccount[] = [];
  let primaryLookupTableAddress: PublicKey | null = null;
  
  // Use lookup table from first mint as primary
  if (mintMapping0.lookupTable) {
    primaryLookupTableAddress = mintMapping0.lookupTable;
    const lookupTable0 = await connection.getAddressLookupTable(primaryLookupTableAddress);
    if (lookupTable0.value) {
      lookupTables.push(lookupTable0.value);
      
      // Check for missing accounts and extend if authorized
      const existingAddresses = new Set(
        lookupTable0.value.state.addresses.map((addr) => addr.toBase58())
      );
      const missingAccounts = allAccounts.filter(
        (addr) => !existingAddresses.has(addr.toBase58())
      );
      
      if (missingAccounts.length > 0 && params.keypair) {
        const lookupTableAccountInfo = await connection.getAccountInfo(primaryLookupTableAddress, 'confirmed');
        if (lookupTableAccountInfo) {
          const authorityBytes = lookupTableAccountInfo.data.slice(1, 33);
          const lookupTableAuthority = new PublicKey(authorityBytes);
          
          if (lookupTableAuthority.equals(payer)) {
            try {
              const extendIx = AddressLookupTableProgram.extendLookupTable({
                authority: payer,
                payer,
                lookupTable: primaryLookupTableAddress,
                addresses: missingAccounts
              });
              
              const extendTx = new Transaction().add(extendIx);
              extendTx.feePayer = payer;
              extendTx.recentBlockhash = latestBlockhash.blockhash;
              extendTx.partialSign(params.keypair);
              
              await connection.sendRawTransaction(extendTx.serialize(), {
                skipPreflight: true,
                maxRetries: 0
              });
              console.log(`[batchTransfer] Extended lookup table with ${missingAccounts.length} accounts`);
            } catch (extendError: any) {
              console.warn(`[batchTransfer] Failed to extend lookup table (non-fatal):`, extendError.message);
            }
          }
        }
      }
    }
  }
  
  // Add second mint's lookup table if different
  if (mintMapping1.lookupTable && primaryLookupTableAddress && !mintMapping1.lookupTable.equals(primaryLookupTableAddress)) {
    const lookupTable1 = await connection.getAddressLookupTable(mintMapping1.lookupTable);
    if (lookupTable1.value && lookupTables.length < 2) {
      lookupTables.push(lookupTable1.value);
      console.log(`[batchTransfer] Added lookup table from mint 1 (${lookupTable1.value.state.addresses.length} addresses)`);
    }
  }
  
  // Require lookup tables for large instruction data (like addDexLiquidity)
  if (lookupTables.length === 0) {
    throw new Error('Lookup table required for batch transfer. Ensure pools are prepared with preparePool().');
  }
  
  console.log(`[batchTransfer] Using ${lookupTables.length} lookup table(s) for compression`);
  
  // Build VersionedTransaction with lookup tables
  let messageV0: MessageV0;
  try {
    const baseMessage = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    });
    
    // Use compileToV0Message with lookup tables for optimal compression
    messageV0 = baseMessage.compileToV0Message(lookupTables);
    console.log(`[batchTransfer] ✓ Compiled MessageV0 with ${lookupTables.length} lookup table(s)`);
  } catch (compileError: any) {
    console.error(`[batchTransfer] compileToV0Message failed:`, compileError.message || compileError);
    
    // If lookup table exists, try manual construction as fallback
    if (lookupTables.length > 0) {
      console.warn(`[batchTransfer] Falling back to manual MessageV0 construction`);
      try {
        messageV0 = buildManualMessageV0(
          payer,
          instructions,
          latestBlockhash.blockhash,
          lookupTables[0]!,
          [payer]
        );
      } catch (manualError: any) {
        console.error('[batchTransfer] Manual MessageV0 construction also failed:', manualError.message || manualError);
        throw new Error(`Failed to build VersionedTransaction message: ${compileError.message || 'Unknown error'}. Instruction data is ${instructionData.length} bytes. Transaction may be too large.`);
      }
    } else {
      throw new Error(`Failed to build VersionedTransaction: ${compileError.message || 'Unknown error'}. Lookup tables required.`);
    }
  }
  
  let versionedTx: VersionedTransaction;
  try {
    versionedTx = new VersionedTransaction(messageV0);
  } catch (txError: any) {
    console.error('[batchTransfer] Failed to create VersionedTransaction:', txError.message || txError);
    throw new Error(`Failed to create VersionedTransaction: ${txError.message || 'Unknown error'}. Message may be too large.`);
  }
  
  // Sign with keypair (required for VersionedTransaction)
  if (!params.keypair) {
    throw new Error('Keypair required for batchTransfer with VersionedTransaction');
  }
  
  // Pre-check: If instruction data is already at or near the limit, warn early
  if (instructionData.length >= 1200) {
    console.warn(`[batchTransfer] ⚠️  Instruction data is very large (${instructionData.length} bytes), close to 1280-byte limit`);
  }
  
  // Try to serialize before signing to check actual size
  // Note: We can't serialize unsigned transaction, but we can estimate
  // V0 transaction: 1 byte version + message + signatures
  // Message overhead: ~50-100 bytes (header, blockhash, account keys via lookup tables, etc.)
  // Signature: 64 bytes
  // Conservative estimate: instruction data + 150 bytes
  const estimatedTxSize = instructionData.length + 150;
  
  if (estimatedTxSize > 1280) {
    console.warn(`[batchTransfer] ⚠️  Estimated transaction size (${estimatedTxSize} bytes) may exceed 1280-byte limit`);
    console.warn(`[batchTransfer] Instruction data: ${instructionData.length} bytes`);
    console.warn(`[batchTransfer] Will attempt to sign and check actual size`);
  }
  
  try {
    versionedTx.sign([params.keypair]);
  } catch (signError: any) {
    // Check if error is related to transaction size
    if (signError.message?.includes('overruns') || signError.message?.includes('too large') || signError.message?.includes('Uint8Array')) {
      // Transaction is too large - try to get actual size if possible
      let actualSize = estimatedTxSize;
      try {
        // Try to serialize to get actual size (might fail, but worth trying)
        const testSerialized = versionedTx.serialize();
        actualSize = testSerialized.length;
      } catch {
        // Can't serialize, use estimate
      }
      
      console.error(`[batchTransfer] ❌ Transaction too large during signing`);
      console.error(`[batchTransfer] Instruction data: ${instructionData.length} bytes`);
      console.error(`[batchTransfer] Estimated/Actual size: ${actualSize} bytes`);
      console.error(`[batchTransfer] Error: ${signError.message}`);
      
      // Provide helpful error with suggestions
      throw new Error(
        `Transaction too large to serialize. Instruction data: ${instructionData.length} bytes. ` +
        `Estimated transaction size: ${actualSize} bytes (exceeds 1280-byte V0 limit). ` +
        `The 1-output optimization is already applied. ` +
        `Consider: (1) Using single transfers instead of batch, (2) Reducing number of transfers, or (3) Further circuit/program optimizations.`
      );
    }
    throw signError;
  }
  
  // Check transaction size after successful signing
  const serialized = versionedTx.serialize();
  console.log(`[batchTransfer] Transaction size: ${serialized.length} bytes`);
  console.log(`[batchTransfer] Instruction data size: ${instructionData.length} bytes`);
  console.log(`[batchTransfer] Solana V0 limit: 1280 bytes`);
  
  if (serialized.length > 1280) {
    console.error(`[batchTransfer] ❌ TRANSACTION TOO LARGE! Exceeds limit by ${serialized.length - 1280} bytes`);
    throw new Error(`Transaction too large: ${serialized.length} > 1280 bytes. Instruction data (${instructionData.length} bytes) plus transaction overhead exceeds limit. Need to reduce instruction data size.`);
  } else if (serialized.length > 1232) {
    console.warn(`[batchTransfer] ⚠️  Transaction exceeds legacy limit (${serialized.length} > 1232), but within V0 limit (${serialized.length} <= 1280)`);
  } else {
    console.log(`[batchTransfer] ✓ Transaction size OK (${serialized.length} <= 1232)`);
  }
  
  // Send transaction
  const signature = await connection.sendRawTransaction(serialized, {
    skipPreflight: false,
    maxRetries: 3
  });
  
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

interface BatchTransferFromParams {
  connection: Connection;
  wallet: WalletContextState;
  proofClient: ProofClient; // Required to generate individual proofs
  transfers: Array<{
    originMint: string;
    poolId: string;
    allowanceOwner: string;
    allowanceAmount: bigint;
    spendAmount: bigint;
    notes: Array<{
      noteId: string;
      spendingKey: string;
      amount: bigint;
    }>;
    outputs: Array<{
      amount: bigint;
      recipient: PublicKey;
      blinding: string;
    }>;
  }>;
  keypair?: Keypair; // Optional keypair for signing
}

export async function batchTransferFrom(params: BatchTransferFromParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const spender = wallet.publicKey;
  if (!spender) {
    throw new Error('Wallet public key missing');
  }
  
  if (params.transfers.length < 2 || params.transfers.length > 10) {
    throw new Error('Batch transferFrom requires 2-10 transfers');
  }
  
  // For now, support exactly 2 transfers
  if (params.transfers.length !== 2) {
    throw new Error('Currently only 2 transfers are supported');
  }
  
  // Validate all transfers
  for (const transfer of params.transfers) {
    if (transfer.spendAmount > transfer.allowanceAmount) {
      throw new Error(`Transfer ${transfer.originMint}: Spend amount exceeds allowance amount`);
    }
    if (transfer.spendAmount <= 0n) {
      throw new Error(`Transfer ${transfer.originMint}: Spend amount must be positive`);
    }
  }
  
  const instructions: TransactionInstruction[] = [];
  
  // Add compute budget (shared for both instructions)
  const computeLimitEnv =
    process.env.BATCH_TRANSFER_FROM_COMPUTE_UNIT_LIMIT ??
    process.env.BATCH_TRANSFER_COMPUTE_UNIT_LIMIT ??
    process.env.TRANSFER_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT;
  const resolvedLimit = (() => {
    if (computeLimitEnv !== undefined) {
      const parsed = Number(computeLimitEnv);
      if (!Number.isNaN(parsed)) {
        return Math.max(parsed, 0);
      }
    }
    return 600_000; // Per instruction
  })();
  if (resolvedLimit > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedLimit * 2 })); // Total for both
  }
  
  // Generate individual proofs for each transfer and create transferFrom instructions
  const transferFromPromises = params.transfers.map(async (transfer) => {
    const originMint = new PublicKey(transfer.originMint);
    const poolStateKey = new PublicKey(transfer.poolId);
    
    // Generate individual transfer proof
    const transferProof = await generateDexTransferProof(
      params.proofClient,
      connection,
      originMint,
      transfer.notes,
      transfer.outputs
    );
    
    // Convert proof to transfer args format
    const transferArgsData = proofToTransferArgs({
      proof: transferProof.proof,
      publicInputs: transferProof.publicInputs,
      oldRoot: transferProof.oldRoot,
      nullifiers: transferProof.nullifiers,
      outputCommitments: transferProof.outputCommitments,
      outputAmountCommitments: transferProof.outputAmountCommitments
    });
    
    // Derive accounts
    const commitmentTreeKey = deriveCommitmentTree(originMint);
    const nullifierSetKey = deriveNullifierSet(originMint);
    const noteLedgerKey = deriveNoteLedger(originMint);
    const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
      connection,
      originMint
    );
    ensureMintActive(mintMapping);
    
    const allowanceOwner = new PublicKey(transfer.allowanceOwner);
    const allowanceKey = deriveAllowanceAccount(poolStateKey, allowanceOwner, spender);
    const verifyingKey = deriveVerifyingKey();
    
    // Build TransferArgs
    const transferArgs = {
      old_root: transferArgsData.old_root,
      new_root: transferArgsData.new_root,
      nullifiers: transferArgsData.nullifiers,
      output_commitments: transferArgsData.output_commitments,
      output_amount_commitments: transferArgsData.output_amount_commitments,
      proof: transferArgsData.proof,
      public_inputs: transferArgsData.public_inputs
    };
    
    const transferFromArgs = {
      transfer: transferArgs,
      allowance_amount: new BN(transfer.allowanceAmount.toString()),
      spend_amount: new BN(transfer.spendAmount.toString())
    };
    
    return new TransactionInstruction({
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
        { pubkey: allowanceOwner, isSigner: false, isWritable: false },
        { pubkey: spender, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      data: poolCoder.instruction.encode('transfer_from', { args: transferFromArgs })
    });
  });
  
  // Wait for all proof generations and instruction building
  const transferFromInstructions = await Promise.all(transferFromPromises);
  instructions.push(...transferFromInstructions);
  
  // Use standard Transaction (not VersionedTransaction) since instructions are now smaller
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

interface ApproveAllowanceParams {
  connection: Connection;
  wallet: WalletContextState;
  originMint: string;
  spender: string;
  amount: bigint | number | string;
  expiresAt?: number | null; // Optional expiration timestamp
}

export async function approveAllowance(params: ApproveAllowanceParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const owner = wallet.publicKey;
  
  const originMintKey = new PublicKey(params.originMint);
  const spenderKey = new PublicKey(params.spender);
  const poolStateKey = derivePoolState(originMintKey);
  const allowanceKey = deriveAllowanceAccount(poolStateKey, owner, spenderKey);
  const { key: mintMappingKey } = await fetchMintMappingAccount(connection, originMintKey);
  
  const amount = BigInt(params.amount);
  const expiresAt = params.expiresAt !== undefined ? (params.expiresAt === null ? null : params.expiresAt) : null;
  
  const instructions: TransactionInstruction[] = [];
  
  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolStateKey, isSigner: false, isWritable: true },
        { pubkey: allowanceKey, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: spenderKey, isSigner: false, isWritable: false },
        { pubkey: originMintKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: mintMappingKey, isSigner: false, isWritable: false }
      ],
      data: poolCoder.instruction.encode('approve_allowance', {
        args: {
          amount: new BN(amount.toString()),
          expires_at: expiresAt === null ? null : expiresAt
        }
      })
    })
  );
  
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(...instructions);
  tx.feePayer = owner;
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

// ============================================================================
// DEX Helper Functions
// ============================================================================

/**
 * Calculate swap output amount using constant product AMM formula with fees.
 * Formula: output = (amount_in * reserve_out * (10000 - fee_bps)) / ((reserve_in * 10000) + (amount_in * (10000 - fee_bps)))
 * 
 * @param amountIn - Input amount
 * @param reserveIn - Input token reserve
 * @param reserveOut - Output token reserve
 * @param feeBps - Fee in basis points (default: 5 = 0.05%)
 * @returns Output amount
 */
export function calculateSwapOutput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number = 5
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) {
    return 0n;
  }
  
  const BPS_DENOMINATOR = 10000n;
  const feeBpsBN = BigInt(feeBps);
  
  // amount_in_with_fee = amount_in * (10000 - fee_bps)
  const amountInWithFee = amountIn * (BPS_DENOMINATOR - feeBpsBN);
  
  // numerator = amount_in_with_fee * reserve_out
  const numerator = amountInWithFee * reserveOut;
  
  // denominator = (reserve_in * 10000) + amount_in_with_fee
  const denominator = (reserveIn * BPS_DENOMINATOR) + amountInWithFee;
  
  // output = numerator / denominator
  return numerator / denominator;
}

/**
 * Calculate LP tokens to mint when adding liquidity.
 * Formula: LP = min((amount_a * total_supply) / reserve_a, (amount_b * total_supply) / reserve_b)
 * 
 * @param amountA - Amount of token A
 * @param amountB - Amount of token B
 * @param reserveA - Reserve of token A
 * @param reserveB - Reserve of token B
 * @param totalSupply - Current LP token total supply
 * @returns LP tokens to mint
 */
export function calculateLPTokens(
  amountA: bigint,
  amountB: bigint,
  reserveA: bigint,
  reserveB: bigint,
  totalSupply: bigint
): bigint {
  if (reserveA === 0n || reserveB === 0n) {
    // First liquidity provider: sqrt(amount_a * amount_b) - MIN_LIQUIDITY
    const MIN_LIQUIDITY = 1000n;
    const product = amountA * amountB;
    const sqrt = BigInt(Math.floor(Math.sqrt(Number(product))));
    return sqrt > MIN_LIQUIDITY ? sqrt - MIN_LIQUIDITY : 0n;
  }
  
  // Calculate LP from both tokens and take minimum
  const lpFromA = (amountA * totalSupply) / reserveA;
  const lpFromB = (amountB * totalSupply) / reserveB;
  
  return lpFromA < lpFromB ? lpFromA : lpFromB;
}

/**
 * Check if a mint is a zToken by checking factory mint mapping.
 * 
 * @param connection - Solana connection
 * @param mint - Mint public key
 * @returns True if mint is a zToken
 */
export async function isZToken(
  connection: Connection,
  mint: PublicKey
): Promise<boolean> {
  try {
    const mintMapping = deriveMintMapping(mint);
    const account = await connection.getAccountInfo(mintMapping, 'confirmed');
    return account !== null && account.owner.equals(FACTORY_PROGRAM_ID);
  } catch {
    return false;
  }
}

// ============================================================================
// DEX SDK Functions
// ============================================================================

/**
 * DEX Pool State interface
 */
export interface DexPoolState {
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  // Note: Both tokens are always zTokens in the zToken-only DEX
  // publicReserveA and publicReserveB removed - only private reserves exist
  privateReserveACommitment: Uint8Array;
  privateReserveAAmount: bigint;
  privateReserveBCommitment: Uint8Array;
  privateReserveBAmount: bigint;
  lpTokenMint: PublicKey;
  totalLpSupply: bigint;
  protocolFeeAccumulatorA: bigint;
  protocolFeeAccumulatorB: bigint;
  lpFeeAccumulatorA: bigint;
  lpFeeAccumulatorB: bigint;
  createdAt: bigint;
  bump: number;
}

/**
 * Re-export deriveDexPoolState for convenience
 */
export { deriveDexPoolState };

/**
 * Get DEX pool state.
 * 
 * @param connection - Solana connection
 * @param tokenA - Token A mint
 * @param tokenB - Token B mint
 * @returns Pool state or null if pool doesn't exist
 */
export async function getDexPoolState(
  connection: Connection,
  tokenA: PublicKey,
  tokenB: PublicKey
): Promise<DexPoolState | null> {
  const poolState = deriveDexPoolState(tokenA, tokenB);
  const account = await connection.getAccountInfo(poolState, 'confirmed');
  
  if (!account) {
    return null;
  }
  
  const decoded = dexCoder.accounts.decode('PoolState', account.data) as any;
  
  return {
    tokenAMint: new PublicKey(decoded.token_a_mint || decoded.tokenAMint),
    tokenBMint: new PublicKey(decoded.token_b_mint || decoded.tokenBMint),
    // Note: Both tokens are always zTokens in the zToken-only DEX
    // publicReserveA and publicReserveB removed - only private reserves exist
    privateReserveACommitment: Buffer.from(decoded.private_reserve_a_commitment || decoded.privateReserveACommitment || Array(32).fill(0)),
    privateReserveAAmount: BigInt(decoded.private_reserve_a_amount?.toString() || decoded.privateReserveAAmount?.toString() || '0'),
    privateReserveBCommitment: Buffer.from(decoded.private_reserve_b_commitment || decoded.privateReserveBCommitment || Array(32).fill(0)),
    privateReserveBAmount: BigInt(decoded.private_reserve_b_amount?.toString() || decoded.privateReserveBAmount?.toString() || '0'),
    lpTokenMint: new PublicKey(decoded.lp_token_mint || decoded.lpTokenMint),
    totalLpSupply: BigInt(decoded.total_lp_supply?.toString() || decoded.totalLpSupply?.toString() || '0'),
    protocolFeeAccumulatorA: BigInt(decoded.protocol_fee_accumulator_a?.toString() || decoded.protocolFeeAccumulatorA?.toString() || '0'),
    protocolFeeAccumulatorB: BigInt(decoded.protocol_fee_accumulator_b?.toString() || decoded.protocolFeeAccumulatorB?.toString() || '0'),
    lpFeeAccumulatorA: BigInt(decoded.lp_fee_accumulator_a?.toString() || decoded.lpFeeAccumulatorA?.toString() || '0'),
    lpFeeAccumulatorB: BigInt(decoded.lp_fee_accumulator_b?.toString() || decoded.lpFeeAccumulatorB?.toString() || '0'),
    createdAt: BigInt(decoded.created_at?.toString() || decoded.createdAt?.toString() || '0'),
    bump: decoded.bump ?? 0
  };
}

/**
 * DEX function parameter interfaces
 */
interface CreateDexPoolParams {
  connection: Connection;
  wallet: WalletContextState;
  tokenA: string | PublicKey; // Must be zToken mint (origin mint)
  tokenB: string | PublicKey; // Must be zToken mint (origin mint)
  initialAmountA: bigint;
  initialAmountB: bigint;
  // Required: Proof client for zToken shield operations
  proofClient: ProofClient;
  // Required: Shield proofs for both tokens (initial liquidity)
  // Should be the full result from generateDexShieldProof
  shieldProofA: { 
    proof: string; 
    publicInputs: string[];
    amountCommit?: Uint8Array; // Optional - will be calculated from publicInputs if not provided
  };
  shieldProofB: { 
    proof: string; 
    publicInputs: string[];
    amountCommit?: Uint8Array; // Optional - will be calculated from publicInputs if not provided
  };
}

interface AddLiquidityParams {
  connection: Connection;
  wallet: WalletContextState;
  tokenA: string | PublicKey; // Must be zToken mint (origin mint)
  tokenB: string | PublicKey; // Must be zToken mint (origin mint)
  amountA: bigint;
  amountB: bigint;
  minLpTokens: bigint;
  // Required: Proof client for zToken operations
  proofClient: ProofClient;
  // Required: User notes for zToken transfers
  zTokenNotesA: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
  zTokenNotesB: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
  // Optional: Keypair for signing VersionedTransaction (required for large instruction data)
  keypair?: Keypair;
}

interface RemoveLiquidityParams {
  connection: Connection;
  wallet: WalletContextState;
  tokenA: string | PublicKey; // Must be zToken mint (origin mint)
  tokenB: string | PublicKey; // Must be zToken mint (origin mint)
  lpAmount: bigint;
  minAmountA: bigint;
  minAmountB: bigint;
  // Required: Proof client for zToken operations
  proofClient: ProofClient;
  // Required: User notes for zToken transfers (pool PDA → user)
  zTokenNotesA: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
  zTokenNotesB: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
}

interface SwapParams {
  connection: Connection;
  wallet: WalletContextState;
  tokenA: string | PublicKey; // Must be zToken mint (origin mint)
  tokenB: string | PublicKey; // Must be zToken mint (origin mint)
  amountIn: bigint;
  minAmountOut: bigint;
  aToB: boolean; // true = swap tokenA -> tokenB, false = swap tokenB -> tokenA
  // Required: Proof client for zToken operations
  proofClient: ProofClient;
  // Required: User notes for zToken input
  zTokenInputNotes: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
}

/**
 * Create a new DEX pool.
 * 
 * @param params - Create pool parameters
 * @returns Transaction signature
 */
export async function createDexPool(params: CreateDexPoolParams): Promise<string> {
  assertWallet(params.wallet);
  if (!params.proofClient) {
    throw new Error('proofClient is required for zToken-only DEX');
  }
  
  const { connection, wallet, proofClient } = params;
  const payer = wallet.publicKey!;
  
  const tokenA = typeof params.tokenA === 'string' ? new PublicKey(params.tokenA) : params.tokenA;
  const tokenB = typeof params.tokenB === 'string' ? new PublicKey(params.tokenB) : params.tokenB;
  
  // Ensure canonical order (token_a < token_b)
  const canonicalOrder = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint] = canonicalOrder ? [tokenA, tokenB] : [tokenB, tokenA];
  const initialAmountA = canonicalOrder ? params.initialAmountA : params.initialAmountB;
  const initialAmountB = canonicalOrder ? params.initialAmountB : params.initialAmountA;
  
  // Derive PDAs
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  
  // Check if pool already exists
  const existingPool = await connection.getAccountInfo(poolState, 'confirmed');
  if (existingPool) {
    throw new Error('Pool already exists');
  }
  
  console.log('[createDexPool] Creating empty pool first (step 1/2), then adding initial liquidity (step 2/2)...');
  
  // STEP 1: Create empty pool (0 amounts, empty ShieldArgs) - small transaction that fits
  const lpTokenMint = Keypair.generate();
  
  // Get user LP token account
  const userLpTokenAccount = await getAssociatedTokenAddress(
    lpTokenMint.publicKey,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Get user token accounts (for depositor_token_account in shield CPI)
  const userTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Derive pool token reserve accounts (ATAs of pool_state PDA)
  // These are required by CreatePool struct but not used for zToken-only pools
  const poolTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint,
    poolState,
    true, // allowOwnerOffCurve = true for PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const poolTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint,
    poolState,
    true, // allowOwnerOffCurve = true for PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Build instruction
  const instructions: TransactionInstruction[] = [];
  
  // Create LP token mint account FIRST (uninitialized - program will initialize it)
  // The program will initialize it with pool_state PDA as mint authority
  const MINT_SIZE = 82;
  const mintLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  
  // Create LP mint with TOKEN_PROGRAM_ID (not TOKEN_2022) to match token_program account
  // This ensures consistency - all tokens use the same program
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: lpTokenMint.publicKey,
      space: MINT_SIZE,
      lamports: mintLamports,
      programId: TOKEN_PROGRAM_ID  // Use TOKEN_PROGRAM_ID to match token_program account
    })
  );
  
  // Note: We don't create the user LP token account ATA here because the mint isn't initialized yet
  // The program will skip minting if the ATA doesn't exist, and we'll handle it in a follow-up transaction
  
  // STEP 1: Create empty pool with 0 amounts and empty ShieldArgs (small transaction)
  console.log('[createDexPool] Step 1/2: Creating empty pool...');
  
  // Use empty ShieldArgs for empty pool creation (program will skip shield CPIs)
  const emptyShieldArgsA = createEmptyShieldArgs();
  const emptyShieldArgsB = createEmptyShieldArgs();
  
  // Encode create_pool instruction with 0 amounts and empty ShieldArgs
  const createPoolData = dexCoder.instruction.encode('create_pool', {
    initial_amount_a: new BN(0),
    initial_amount_b: new BN(0),
    shield_args_a: emptyShieldArgsA,
    shield_args_b: emptyShieldArgsB
  });
  
  // Get pool state bump (for PDA derivation)
  const [poolStatePDA, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool'),
      tokenAMint.toBuffer(),
      tokenBMint.toBuffer()
    ],
    DEX_PROGRAM_ID
  );
  
  // Build instruction keys for empty pool creation (no shield CPIs, so minimal accounts needed)
  // Account order must match CreatePool struct exactly:
  // token_a_mint, token_b_mint, pool_state, lp_token_mint, user_lp_token_account,
  // user_token_a_account, pool_token_a_account, user_token_b_account, pool_token_b_account,
  // payer, token_program, associated_token_program, system_program, rent
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: lpTokenMint.publicKey, isSigner: false, isWritable: true }, // Not a signer in create_pool instruction, only for SystemProgram.createAccount
    { pubkey: userLpTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenAAccount, isSigner: false, isWritable: true }, // Pool's token A reserve (not used for zToken-only, but required by struct)
    { pubkey: userTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenBAccount, isSigner: false, isWritable: true }, // Pool's token B reserve (not used for zToken-only, but required by struct)
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Empty pool creation doesn't need zToken accounts (shields are skipped)
  
  instructions.push(
    new TransactionInstruction({
      programId: DEX_PROGRAM_ID,
      keys: instructionKeys,
      data: createPoolData
    })
  );
  
  // Step 1: Create empty pool (should be small transaction)
  console.log('[createDexPool] Sending empty pool creation transaction...');
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const createPoolTx = new Transaction().add(...instructions);
  createPoolTx.feePayer = payer;
  createPoolTx.recentBlockhash = latestBlockhash.blockhash;
  
  console.log(`[createDexPool] Empty pool transaction: ${instructions.length} instructions, data=${createPoolData.length} bytes`);
  console.log(`[createDexPool] Payer: ${payer.toBase58()}, Wallet public key: ${wallet.publicKey?.toBase58()}`);
  
  // Sign with wallet (payer) first - fee payer must be first signer
  if (!wallet.signTransaction) {
    throw new Error('Wallet does not support signTransaction');
  }
  const signedByWallet = await wallet.signTransaction(createPoolTx);
  console.log(`[createDexPool] After wallet.signTransaction: ${signedByWallet.signatures.length} signatures`);
  
  // Verify payer signature is present and first (as fee payer)
  const payerSignature = signedByWallet.signatures.find(sig => sig.publicKey.equals(payer));
  if (!payerSignature || payerSignature.signature === null) {
    console.error(`[createDexPool] ERROR: Payer signature missing! Signatures:`, signedByWallet.signatures.map(s => ({ pubkey: s.publicKey.toBase58(), signed: s.signature !== null })));
    throw new Error('Payer signature is missing after wallet.signTransaction');
  }
  
  // Then sign with lpTokenMint (for SystemProgram.createAccount instruction)
  signedByWallet.partialSign(lpTokenMint);
  console.log(`[createDexPool] After lpTokenMint partialSign: ${signedByWallet.signatures.length} signatures`);
  
  const signedTx = signedByWallet;
  
  console.log(`[createDexPool] Transaction signed with ${signedTx.signatures.length} signatures`);
  
  const createPoolSig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
  await waitForSignatureConfirmation(
    connection,
    createPoolSig,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );
  
  console.log('[createDexPool] ✅ Empty pool created:', createPoolSig);
  
  // STEP 2: Add initial liquidity (if amounts > 0)
  // Note: For now, we create an empty pool and return. 
  // Users should call addDexLiquidity separately after shielding tokens and obtaining notes.
  // This is because readStoredNotes may not be available in all SDK contexts.
  if (initialAmountA > 0n || initialAmountB > 0n) {
    console.log('[createDexPool] ⚠️  Initial amounts provided, but automatic liquidity addition not implemented.');
    console.log('[createDexPool]    To add initial liquidity:');
    console.log('[createDexPool]    1. Shield tokens to yourself using wrap()');
    console.log('[createDexPool]    2. Get your zToken notes (from localStorage or indexer)');
    console.log('[createDexPool]    3. Call addDexLiquidity() with your notes');
  }
  
  console.log('[createDexPool] ✅ Empty pool created successfully');
  return createPoolSig;
}

/**
 * Add liquidity to a DEX pool.
 * 
 * @param params - Add liquidity parameters
 * @returns Transaction signature
 */
export async function addDexLiquidity(params: AddLiquidityParams): Promise<string> {
  assertWallet(params.wallet);
  if (!params.proofClient) {
    throw new Error('proofClient is required for zToken-only DEX');
  }
  if (!params.zTokenNotesA || !params.zTokenNotesB) {
    throw new Error('zTokenNotesA and zTokenNotesB are required for zToken-only DEX');
  }
  
  const { connection, wallet, proofClient } = params;
  const payer = wallet.publicKey!;
  
  const tokenA = typeof params.tokenA === 'string' ? new PublicKey(params.tokenA) : params.tokenA;
  const tokenB = typeof params.tokenB === 'string' ? new PublicKey(params.tokenB) : params.tokenB;
  
  // Ensure canonical order
  const canonicalOrder = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint] = canonicalOrder ? [tokenA, tokenB] : [tokenB, tokenA];
  const amountA = canonicalOrder ? params.amountA : params.amountB;
  const amountB = canonicalOrder ? params.amountB : params.amountA;
  
  // Get notes in canonical order
  const zTokenNotesA = canonicalOrder ? params.zTokenNotesA : params.zTokenNotesB;
  const zTokenNotesB = canonicalOrder ? params.zTokenNotesB : params.zTokenNotesA;
  
  // Get pool state to check if it exists and get LP mint
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
  if (!poolStateData) {
    throw new Error('Pool does not exist. Create pool first.');
  }
  
  const lpTokenMint = poolStateData.lpTokenMint;
  
  // Get LP mint info
  const lpMintInfo = await connection.getAccountInfo(lpTokenMint, 'confirmed');
  if (!lpMintInfo) {
    throw new Error(`LP token mint does not exist: ${lpTokenMint.toBase58()}. Pool may not have been created properly.`);
  }
  const lpMintProgramId = lpMintInfo.owner;
  if (!lpMintProgramId.equals(TOKEN_PROGRAM_ID) && !lpMintProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`LP token mint has invalid owner: ${lpMintProgramId.toBase58()}. Expected TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID.`);
  }
  const lpTokenProgramId = lpMintProgramId.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  
  // Get user LP token account
  const userLpTokenAccount = await getAssociatedTokenAddress(
    lpTokenMint,
    payer,
    false,
    lpTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Get user token accounts (for depositor_token_account in transfer CPI)
  const userTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Get pool reserve token accounts (required by struct even though not used for zToken-only)
  const poolTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint,
    poolState,
    true, // allowOwnerOffCurve
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const poolTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint,
    poolState,
    true, // allowOwnerOffCurve
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Build instruction
  const instructions: TransactionInstruction[] = [];
  
  // Create user LP token account if it doesn't exist
  const userLpAccountInfo = await connection.getAccountInfo(userLpTokenAccount, 'confirmed');
  if (!userLpAccountInfo || userLpAccountInfo.owner.equals(SystemProgram.programId)) {
    console.log(`[addDexLiquidity] Creating user LP token account...`);
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payer,
        userLpTokenAccount,
        payer,
        lpTokenMint,
        lpTokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  
  // Generate transfer proofs for both tokens (user → pool PDA)
  // Select notes that cover the required amounts
  function selectNotesForAmount(
    notes: Array<{ noteId: string; spendingKey: string; amount: bigint }>,
    target: bigint
  ): Array<{ noteId: string; spendingKey: string; amount: bigint }> {
    if (!notes.length) {
      throw new Error('No notes available');
    }
    // Sort notes by amount (ascending)
    const sorted = [...notes].sort((a, b) => {
      const diff = a.amount - b.amount;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    // Try to find a single note that covers the amount
    const single = sorted.find(note => note.amount >= target);
    if (single) {
      return [single];
    }
    // Try to find two notes that cover the amount
    let bestPair: { total: bigint; notes: Array<{ noteId: string; spendingKey: string; amount: bigint }> } | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      for (let j = i - 1; j >= 0; j--) {
        const total = sorted[i]!.amount + sorted[j]!.amount;
        if (total >= target) {
          if (!bestPair || total < bestPair.total) {
            bestPair = { total, notes: [sorted[i]!, sorted[j]!] };
          }
        }
      }
    }
    if (bestPair) {
      return bestPair.notes;
    }
    throw new Error(`Insufficient notes: need ${target}, have ${sorted.reduce((sum, n) => sum + n.amount, 0n)}`);
  }
  
  const selectedNotesA = selectNotesForAmount(zTokenNotesA, amountA);
  const selectedNotesB = selectNotesForAmount(zTokenNotesB, amountB);
  
  // Generate batch transfer proof for both tokens atomically
  console.log('[addDexLiquidity] Generating batch transfer proof for token A and token B...');
  const batchProof = await generateBatchLiquidityProof(
    proofClient,
    connection,
    tokenAMint,
    tokenBMint,
    selectedNotesA,
    selectedNotesB,
    amountA,
    amountB,
    poolState, // recipient is pool PDA for both transfers
    payer // change goes back to user
  );
  
  console.log('[addDexLiquidity] Batch proof generated successfully');
  
  // Convert batch proof to BatchTransferArgs format
  // Extract individual transfer data from batch proof results
  const transferDataA = batchProof.transfers[0];
  const transferDataB = batchProof.transfers[1];
  
  if (!transferDataA || !transferDataB) {
    throw new Error('Batch proof must contain exactly 2 transfers');
  }
  
  // Build TransferArgs for each transfer from batch proof data
  const transferArgsA = {
    old_root: Array.from(canonicalHexToBytesLE(canonicalizeHex(transferDataA.oldRoot))),
    new_root: Array.from(canonicalHexToBytesLE(canonicalizeHex(transferDataA.newRoot))),
    nullifiers: transferDataA.nullifiers.map(n => Array.from(n)),
    output_commitments: transferDataA.outputCommitments.map(c => Array.from(c)),
    output_amount_commitments: transferDataA.outputAmountCommitments.map(c => Array.from(c)),
    proof: [], // Empty Vec<u8> - batch proof used instead (program ignores this field in batch mode, saves 192 bytes)
    public_inputs: [] // Empty Vec<u8> - batch public inputs used instead (program ignores this field in batch mode, saves 64 bytes)
  };
  
  const transferArgsB = {
    old_root: Array.from(canonicalHexToBytesLE(canonicalizeHex(transferDataB.oldRoot))),
    new_root: Array.from(canonicalHexToBytesLE(canonicalizeHex(transferDataB.newRoot))),
    nullifiers: transferDataB.nullifiers.map(n => Array.from(n)),
    output_commitments: transferDataB.outputCommitments.map(c => Array.from(c)),
    output_amount_commitments: transferDataB.outputAmountCommitments.map(c => Array.from(c)),
    proof: [], // Empty Vec<u8> - batch proof used instead (program ignores this field in batch mode, saves 192 bytes)
    public_inputs: [] // Empty Vec<u8> - batch public inputs used instead (program ignores this field in batch mode, saves 64 bytes)
  };
  
  // Create BatchTransferArgs with batch proof and combined public inputs
  const batchProofBytes = Buffer.from(batchProof.proof, 'base64');
  const batchPublicInputsBytes = Buffer.concat(
    batchProof.publicInputs.map(input => canonicalHexToBytesLE(canonicalizeHex(input)))
  );
  
  const batchTransferArgs = {
    transfers: [transferArgsA, transferArgsB],
    proof: Array.from(batchProofBytes),
    public_inputs: Array.from(batchPublicInputsBytes)
  };
  
  // Encode add_liquidity instruction with BatchTransferArgs
  // This uses a single batch proof instead of two separate proofs, reducing transaction size
  let addLiquidityData: Buffer;
  try {
    addLiquidityData = dexCoder.instruction.encode('add_liquidity', {
      amount_a: new BN(amountA.toString()),
      amount_b: new BN(amountB.toString()),
      min_lp_tokens: new BN(params.minLpTokens.toString()),
      batch_transfer_args: batchTransferArgs  // BatchTransferArgs with single batch proof
    });
  } catch (error: any) {
    if (error instanceof Error && (error.message.includes('encoding overruns Buffer') || error.message.includes('Blob.encode') || error.message.includes('offset') || error.message.includes('1232'))) {
      // Workaround: Manually encode with larger buffer for large TransferArgs
      // Similar to bootstrap script's approach
      console.log('[addDexLiquidity] Using manual encoding workaround for large TransferArgs');
      
      const ixLayouts = (dexCoder.instruction as unknown as { ixLayouts?: Map<string, { discriminator: number[]; layout: any }> }).ixLayouts?.get('add_liquidity');
      if (!ixLayouts) {
        throw error;
      }
      const { discriminator, layout } = ixLayouts;
      const discriminatorBuffer = Buffer.from(discriminator);
      
      const args = {
        amount_a: new BN(amountA.toString()),
        amount_b: new BN(amountB.toString()),
        min_lp_tokens: new BN(params.minLpTokens.toString()),
        batch_transfer_args: batchTransferArgs
      };
      
          // Better size estimation (similar to bootstrap script)
      const estimatedSize = 8 + // discriminator
        Object.values(args).reduce<number>((acc, value) => {
          if (value instanceof Buffer || value instanceof Uint8Array) {
            return acc + 4 + value.length; // Vec<u8> has 4-byte length prefix
          }
          if (value instanceof BN) {
            return acc + 8; // u64
          }
          if (Array.isArray(value)) {
            return acc + value.length; // Array elements
          }
          if (value && typeof value === 'object') {
            // For BatchTransferArgs object, estimate based on its fields
            const bta = value as any;
            let size = 4; // transfers vec length prefix
            // Estimate size for each transfer (TransferArgs)
            if (Array.isArray(bta.transfers)) {
              for (const ta of bta.transfers) {
                size += 32 + 32; // old_root + new_root
                size += 4 + (ta.nullifiers?.length || 0) * 32; // nullifiers vec
                size += 4 + (ta.output_commitments?.length || 0) * 32; // output_commitments vec
                size += 4 + (ta.output_amount_commitments?.length || 0) * 32; // output_amount_commitments vec
                size += 4 + (Array.isArray(ta.proof) ? ta.proof.length : (ta.proof?.length || 192)); // proof vec (dummy, batch proof used)
                size += 4 + (Array.isArray(ta.public_inputs) ? ta.public_inputs.length : (ta.public_inputs?.length || 0)); // public_inputs vec (dummy, batch used)
              }
            }
            // Batch proof and public_inputs
            size += 4 + (Array.isArray(bta.proof) ? bta.proof.length : (bta.proof?.length || 192)); // proof vec
            size += 4 + (Array.isArray(bta.public_inputs) ? bta.public_inputs.length : (bta.public_inputs?.length || 512)); // public_inputs vec (16 field elements * 32 bytes)
            return acc + size;
          }
          return acc + 64; // Default estimate
        }, 1024);
      
      // Allocate much larger buffer (at least 128KB to ensure we have enough space)
      const bufferSize = Math.max(estimatedSize * 2, 128 * 1024);
      console.log(`[addDexLiquidity] Allocating buffer of size: ${bufferSize} bytes (estimated: ${estimatedSize})`);
      const buffer = Buffer.alloc(bufferSize);
      
      try {
        // Clear buffer to ensure it's zero-initialized
        buffer.fill(0);
        const len = layout.encode(args, buffer);
        if (typeof len !== 'number' || len <= 0) {
          throw new Error(`Invalid encoded length: ${len}`);
        }
        if (len > buffer.length) {
          throw new Error(`Encoded length (${len}) exceeds buffer size (${buffer.length})`);
        }
        addLiquidityData = Buffer.concat([discriminatorBuffer, buffer.slice(0, len)]);
        console.log(`[addDexLiquidity] Successfully encoded instruction data: ${addLiquidityData.length} bytes (buffer was ${buffer.length} bytes, encoded length: ${len})`);
      } catch (encodeError: any) {
        console.error('[addDexLiquidity] Manual encoding failed:', encodeError.message || encodeError);
        // Last resort: Manually serialize BatchTransferArgs using types coder, then manually construct instruction
        console.log('[addDexLiquidity] Attempting manual Borsh serialization...');
        
        try {
          // Serialize BatchTransferArgs using types coder (bypasses layout encoder)
          const batchTransferArgsBytes = dexCoder.types.encode('BatchTransferArgs', batchTransferArgs);
          
          console.log(`[addDexLiquidity] BatchTransferArgs: ${batchTransferArgsBytes.length} bytes`);
          
          // Manually construct instruction data using Borsh serialization
          // Structure: discriminator + u64(amount_a) + u64(amount_b) + u64(min_lp_tokens) + BatchTransferArgs
          const instructionParts: Buffer[] = [discriminatorBuffer];
          
          // Serialize u64 fields (little-endian, 8 bytes each)
          const amountABuf = Buffer.allocUnsafe(8);
          amountABuf.writeBigUInt64LE(BigInt(amountA.toString()), 0);
          instructionParts.push(amountABuf);
          
          const amountBBuf = Buffer.allocUnsafe(8);
          amountBBuf.writeBigUInt64LE(BigInt(amountB.toString()), 0);
          instructionParts.push(amountBBuf);
          
          const minLpTokensBuf = Buffer.allocUnsafe(8);
          minLpTokensBuf.writeBigUInt64LE(BigInt(params.minLpTokens.toString()), 0);
          instructionParts.push(minLpTokensBuf);
          
          // Append serialized BatchTransferArgs (already in Borsh format from types encoder)
          instructionParts.push(batchTransferArgsBytes);
          
          addLiquidityData = Buffer.concat(instructionParts);
          console.log(`[addDexLiquidity] Successfully manually serialized instruction: ${addLiquidityData.length} bytes`);
        } catch (manualError: any) {
          console.error('[addDexLiquidity] Manual Borsh serialization also failed:', manualError.message || manualError);
          throw error; // Throw original error
        }
      }
    } else {
      throw error;
    }
  }
  
  // Build instruction keys (both tokens are always zTokens)
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: lpTokenMint, isSigner: false, isWritable: true },
    { pubkey: userLpTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenAAccount, isSigner: false, isWritable: true }, // Required by struct
    { pubkey: userTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenBAccount, isSigner: false, isWritable: true }, // Required by struct
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add zToken pool accounts to remaining_accounts for batch_private_transfer CPI
  // The helper function parse_ztoken_accounts searches by PDA, so order doesn't strictly matter,
  // but we'll pass accounts in a logical order: first pool (7), second pool (7), then common (3)
  console.info('[addDexLiquidity] Adding zToken pool accounts to remaining_accounts for batch transfer');
  
  // Token A zToken accounts (first pool - 7 accounts total)
  const zTokenAccountsA = getZTokenPoolAccounts(tokenAMint, false); // forShield = false (transfer)
  instructionKeys.push(...zTokenAccountsA.map(pubkey => ({ 
    pubkey, 
    isSigner: false, 
    isWritable: true
  })));
  
  // Token B zToken accounts (second pool - 7 accounts total)
  const zTokenAccountsB = getZTokenPoolAccounts(tokenBMint, false);
  instructionKeys.push(...zTokenAccountsB.map(pubkey => ({ 
    pubkey, 
    isSigner: false, 
    isWritable: true
  })));
  
  // Common accounts (payer, system_program, rent) - these are already in explicit accounts
  // but need to be in remaining_accounts for the CPI to find them
  // Note: payer is already in explicit accounts, but parse_cpi_common_accounts will find it in remaining_accounts
  instructionKeys.push(
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );
  
  instructions.push(
    new TransactionInstruction({
      programId: DEX_PROGRAM_ID,
      keys: instructionKeys,
      data: addLiquidityData
    })
  );
  
  // Send transaction using VersionedTransaction to support large instruction data (1288 bytes > 1232 limit)
  console.log(`[addDexLiquidity] Instruction data size: ${addLiquidityData.length} bytes (exceeds 1232-byte limit, using VersionedTransaction)`);
  
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  
  // OPTIMIZE LOOKUP TABLE COMPRESSION (Option 1)
  // Collect ALL accounts used in add_liquidity instruction for optimal compression
  const allAccountsSet = new Set<string>();
  const allAccounts: PublicKey[] = [];
  
  // Helper to add account if not already added
  const addAccount = (pubkey: PublicKey) => {
    const addr = pubkey.toBase58();
    if (!allAccountsSet.has(addr)) {
      allAccountsSet.add(addr);
      allAccounts.push(pubkey);
    }
  };
  
  // Add all accounts from instruction keys (except payer/signers which must be direct)
  for (const key of instructionKeys) {
    if (!key.isSigner) {
      addAccount(key.pubkey);
    }
  }
  
  // Add DEX program ID (implicit)
  addAccount(DEX_PROGRAM_ID);
  
  console.log(`[addDexLiquidity] Collected ${allAccounts.length} unique accounts for compression`);
  
  // Get lookup tables if available to compress accounts
  const { decoded: mintMappingA } = await fetchMintMappingAccount(connection, tokenAMint);
  const { decoded: mintMappingB } = await fetchMintMappingAccount(connection, tokenBMint);
  
  let signature: string;
  const lookupTables: AddressLookupTableAccount[] = [];
  let primaryLookupTableAddress: PublicKey | null = null;
  
  // Use lookup table A as primary, extend it with missing accounts if needed
  if (mintMappingA.lookupTable) {
    primaryLookupTableAddress = mintMappingA.lookupTable;
    const lookupTableA = await connection.getAddressLookupTable(primaryLookupTableAddress);
    if (lookupTableA.value) {
      lookupTables.push(lookupTableA.value);
      
      // Check which accounts are missing from lookup table A
      const existingAddresses = new Set(
        lookupTableA.value.state.addresses.map((addr) => addr.toBase58())
      );
      const missingAccounts = allAccounts.filter(
        (addr) => !existingAddresses.has(addr.toBase58())
      );
      
      if (missingAccounts.length > 0) {
        console.log(`[addDexLiquidity] ${missingAccounts.length} accounts missing from lookup table A: ${missingAccounts.map(a => a.toBase58().slice(0, 8)).join(', ')}`);
        
        // Check if payer is the lookup table authority (required for extension)
        const lookupTableAccountInfo = await connection.getAccountInfo(primaryLookupTableAddress, 'confirmed');
        if (lookupTableAccountInfo) {
          // Parse lookup table authority (first 32 bytes after discriminator)
          const authorityBytes = lookupTableAccountInfo.data.slice(1, 33); // Skip discriminator byte
          const lookupTableAuthority = new PublicKey(authorityBytes);
          
          if (lookupTableAuthority.equals(payer) && params.keypair) {
            console.log(`[addDexLiquidity] Payer is lookup table authority, attempting to extend with ${missingAccounts.length} accounts`);
            
            try {
              // Extend lookup table with missing accounts (non-blocking - proceed even if this fails)
              const extendBlockhash = await connection.getLatestBlockhash('confirmed');
              const extendIx = AddressLookupTableProgram.extendLookupTable({
                authority: payer,
                payer,
                lookupTable: primaryLookupTableAddress,
                addresses: missingAccounts
              });
              
              const extendTx = new Transaction().add(extendIx);
              extendTx.feePayer = payer;
              extendTx.recentBlockhash = extendBlockhash.blockhash;
              extendTx.partialSign(params.keypair);
              
              const extendSig = await connection.sendRawTransaction(extendTx.serialize(), { skipPreflight: false });
              await waitForSignatureConfirmation(
                connection,
                extendSig,
                extendBlockhash.blockhash,
                extendBlockhash.lastValidBlockHeight
              );
              console.log(`[addDexLiquidity] ✓ Extended lookup table A: ${extendSig}`);
              
              // Reload lookup table after extension
              const reloadedTable = await connection.getAddressLookupTable(primaryLookupTableAddress);
              if (reloadedTable.value) {
                lookupTables[0] = reloadedTable.value;
                console.log(`[addDexLiquidity] Lookup table A now has ${reloadedTable.value.state.addresses.length} addresses`);
              }
            } catch (extendError: any) {
              console.warn(`[addDexLiquidity] Failed to extend lookup table (non-fatal): ${extendError.message || extendError}. Proceeding with existing compression.`);
            }
          } else {
            console.warn(`[addDexLiquidity] Cannot extend lookup table - payer (${payer.toBase58()}) is not authority (${lookupTableAuthority.toBase58()}) or keypair missing. Proceeding with partial compression.`);
          }
        }
      } else {
        console.log(`[addDexLiquidity] All accounts already in lookup table A (${lookupTableA.value.state.addresses.length} addresses)`);
      }
    }
  }
  
  // Add lookup table B if different from A (can use up to 2 lookup tables)
  if (mintMappingB.lookupTable && mintMappingB.lookupTable.toBase58() !== primaryLookupTableAddress?.toBase58() && lookupTables.length < 2) {
    const lookupTableB = await connection.getAddressLookupTable(mintMappingB.lookupTable);
    if (lookupTableB.value) {
      lookupTables.push(lookupTableB.value);
      console.log(`[addDexLiquidity] Added lookup table B (${lookupTableB.value.state.addresses.length} addresses)`);
    }
  }
  
  // Build VersionedTransaction using optimal lookup table compression
  if (lookupTables.length === 0) {
    throw new Error('Lookup table required for large instruction data. Ensure pools are prepared.');
  }
  
  console.log(`[addDexLiquidity] Using ${lookupTables.length} lookup table(s) for compression`);
  
  // Use TransactionMessage.compileToV0Message for optimal compression with multiple lookup tables
  // This handles account compression automatically
  let messageV0: MessageV0;
  try {
    const baseMessage = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latestBlockhash.blockhash,
      instructions
    });
    
    // Use compileToV0Message with all lookup tables for maximum compression
    messageV0 = baseMessage.compileToV0Message(lookupTables);
    console.log(`[addDexLiquidity] ✓ Compiled MessageV0 with ${lookupTables.length} lookup table(s)`);
  } catch (msgError: any) {
    console.error('[addDexLiquidity] Failed to compile MessageV0:', msgError.message || msgError);
    
    // Fallback to manual MessageV0 construction with primary lookup table only
    console.warn('[addDexLiquidity] Falling back to manual MessageV0 construction');
    try {
      messageV0 = buildManualMessageV0(
        payer,
        instructions,
        latestBlockhash.blockhash,
        lookupTables[0]!,
        [payer] // Signers
      );
    } catch (manualError: any) {
      console.error('[addDexLiquidity] Manual MessageV0 construction also failed:', manualError.message || manualError);
      throw new Error(`Failed to build VersionedTransaction message: ${msgError.message || 'Unknown error'}. Instruction data is ${addLiquidityData.length} bytes. Consider splitting the operation.`);
    }
  }
  
  let versionedTx: VersionedTransaction;
  try {
    versionedTx = new VersionedTransaction(messageV0);
  } catch (txError: any) {
    console.error('[addDexLiquidity] Failed to create VersionedTransaction:', txError.message || txError);
    throw new Error(`Failed to create VersionedTransaction: ${txError.message || 'Unknown error'}. Total message size may be too large.`);
  }
  
  // Sign with keypair (required for VersionedTransaction)
  if (!params.keypair) {
    throw new Error('Keypair required for VersionedTransaction signing with large instruction data');
  }
  
  try {
    versionedTx.sign([params.keypair]);
  } catch (signError: any) {
    console.error('[addDexLiquidity] Failed to sign VersionedTransaction:', signError.message || signError);
    throw new Error(`Failed to sign VersionedTransaction: ${signError.message || 'Unknown error'}`);
  }
  
  let serialized: Uint8Array;
  try {
    serialized = versionedTx.serialize();
    console.log(`[addDexLiquidity] VersionedTransaction serialized successfully: ${serialized.length} bytes`);
  } catch (serializeError: any) {
    console.error('[addDexLiquidity] Failed to serialize VersionedTransaction:', serializeError.message || serializeError);
    throw new Error(`Failed to serialize VersionedTransaction: ${serializeError.message || 'Unknown error'}. Transaction may be too large.`);
  }
  
  signature = await connection.sendRawTransaction(serialized, { skipPreflight: false });
  
  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );
  
  return signature;
}

/**
 * Remove liquidity from a DEX pool.
 * 
 * @param params - Remove liquidity parameters
 * @returns Transaction signature
 */
export async function removeDexLiquidity(params: RemoveLiquidityParams): Promise<string> {
  assertWallet(params.wallet);
  if (!params.proofClient) {
    throw new Error('proofClient is required for zToken-only DEX');
  }
  if (!params.zTokenNotesA || !params.zTokenNotesB) {
    throw new Error('zTokenNotesA and zTokenNotesB are required for zToken-only DEX');
  }
  
  const { connection, wallet, proofClient } = params;
  const payer = wallet.publicKey!;
  
  const tokenA = typeof params.tokenA === 'string' ? new PublicKey(params.tokenA) : params.tokenA;
  const tokenB = typeof params.tokenB === 'string' ? new PublicKey(params.tokenB) : params.tokenB;
  
  // Ensure canonical order
  const [tokenAMint, tokenBMint] = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0
    ? [tokenA, tokenB]
    : [tokenB, tokenA];
  
  const minAmountA = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0 
    ? params.minAmountA 
    : params.minAmountB;
  const minAmountB = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0 
    ? params.minAmountB 
    : params.minAmountA;
  
  // Get notes in canonical order
  const zTokenNotesA = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0 
    ? params.zTokenNotesA 
    : params.zTokenNotesB;
  const zTokenNotesB = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0 
    ? params.zTokenNotesB 
    : params.zTokenNotesA;
  
  // Get pool state
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
  if (!poolStateData) {
    throw new Error('Pool does not exist.');
  }
  
  const lpTokenMint = poolStateData.lpTokenMint;
  
  // Get LP mint info
  const lpMintInfo = await connection.getAccountInfo(lpTokenMint, 'confirmed');
  if (!lpMintInfo) {
    throw new Error(`LP token mint does not exist: ${lpTokenMint.toBase58()}`);
  }
  const lpTokenProgramId = lpMintInfo.owner;
  if (!lpTokenProgramId.equals(TOKEN_PROGRAM_ID) && !lpTokenProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`LP token mint has invalid owner: ${lpTokenProgramId.toBase58()}`);
  }
  
  // Get token accounts
  const userLpTokenAccount = await getAssociatedTokenAddress(
    lpTokenMint,
    payer,
    false,
    lpTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const instructions: TransactionInstruction[] = [];
  
  // Generate transfer proofs for both tokens (pool PDA → user)
  // Note: For remove_liquidity, the pool PDA transfers zTokens to the user
  // This requires pool PDA notes which need special handling (TODO: implement pool PDA note fetching)
  // For now, we'll use empty notes and let the program handle it
  // TODO: Fetch pool PDA notes from indexer or derive from pool state
  if (!params.zTokenNotesA || !params.zTokenNotesB || params.zTokenNotesA.length === 0 || params.zTokenNotesB.length === 0) {
    throw new Error('Pool PDA notes are required for remove_liquidity. This feature is not yet implemented.');
  }
  
  // For now, we'll use placeholder - pool PDA note handling needs to be implemented
  const transferProofA = await generateDexTransferProofSimple(
    proofClient,
    connection,
    tokenAMint,
    params.zTokenNotesA, // Pool PDA notes (placeholder)
    minAmountA,
    payer // recipient is user
  );
  
  const transferProofB = await generateDexTransferProofSimple(
    proofClient,
    connection,
    tokenBMint,
    params.zTokenNotesB, // Pool PDA notes (placeholder)
    minAmountB,
    payer // recipient is user
  );
  
  // Convert proofs to TransferArgs
  const transferArgsA = proofToTransferArgs(transferProofA);
  const transferArgsB = proofToTransferArgs(transferProofB);
  
  // Encode remove_liquidity instruction
  const removeLiquidityData = dexCoder.instruction.encode('remove_liquidity', {
    lp_amount: new BN(params.lpAmount.toString()),
    min_amount_a: new BN(minAmountA.toString()),
    min_amount_b: new BN(minAmountB.toString()),
    transfer_args_a: transferArgsA,  // Required: TransferArgs for zToken A
    transfer_args_b: transferArgsB   // Required: TransferArgs for zToken B
  });
  
  // Build instruction keys (both tokens are always zTokens)
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: lpTokenMint, isSigner: false, isWritable: true },
    { pubkey: userLpTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add zToken pool accounts to remaining_accounts for transfer CPIs
  // For transfer operations (pool PDA → user), we need 7 accounts per zToken
  console.info('[removeDexLiquidity] Adding zToken pool accounts to remaining_accounts');
  
  // Token A zToken accounts
  const zTokenAccountsA = getZTokenPoolAccounts(tokenAMint, false); // forShield = false (transfer)
  instructionKeys.push(...zTokenAccountsA.map(pubkey => ({ 
    pubkey, 
    isSigner: false, 
    isWritable: true
  })));
  
  // Token B zToken accounts
  const zTokenAccountsB = getZTokenPoolAccounts(tokenBMint, false); // forShield = false (transfer)
  instructionKeys.push(...zTokenAccountsB.map(pubkey => ({ 
    pubkey, 
    isSigner: false, 
    isWritable: true
  })));
  
  // Add payer, system_program, rent to remaining_accounts for CPIs
  instructionKeys.push(
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );
  
  instructions.push(
    new TransactionInstruction({
      programId: DEX_PROGRAM_ID,
      keys: instructionKeys,
      data: removeLiquidityData
    })
  );
  
  // Send transaction
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

/**
 * Execute a swap on a DEX pool.
 * 
 * @param params - Swap parameters
 * @returns Transaction signature
 */
export async function swapDex(params: SwapParams): Promise<string> {
  assertWallet(params.wallet);
  if (!params.proofClient) {
    throw new Error('proofClient is required for zToken-only DEX');
  }
  if (!params.zTokenInputNotes) {
    throw new Error('zTokenInputNotes is required for zToken-only DEX');
  }
  
  const { connection, wallet, proofClient } = params;
  const payer = wallet.publicKey!;
  
  const tokenA = typeof params.tokenA === 'string' ? new PublicKey(params.tokenA) : params.tokenA;
  const tokenB = typeof params.tokenB === 'string' ? new PublicKey(params.tokenB) : params.tokenB;
  
  // Ensure canonical order
  const canonicalOrder = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint] = canonicalOrder ? [tokenA, tokenB] : [tokenB, tokenA];
  
  // Determine which direction we're swapping
  const actualAToB = canonicalOrder === params.aToB;
  
  // Get pool state
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
  if (!poolStateData) {
    throw new Error('Pool does not exist.');
  }
  
  // Determine input/output tokens based on swap direction
  const tokenInMint = actualAToB ? tokenAMint : tokenBMint;
  const tokenOutMint = actualAToB ? tokenBMint : tokenAMint;
  
  // Get token accounts
  const userTokenInAccount = await getAssociatedTokenAddress(
    tokenInMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenOutAccount = await getAssociatedTokenAddress(
    tokenOutMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Build instruction
  const instructions: TransactionInstruction[] = [];
  
  // Generate transfer proof for input (user → pool PDA)
  function selectNotesForAmount(
    notes: Array<{ noteId: string; spendingKey: string; amount: bigint }>,
    target: bigint
  ): Array<{ noteId: string; spendingKey: string; amount: bigint }> {
    if (!notes.length) {
      throw new Error('No notes available');
    }
    const sorted = [...notes].sort((a, b) => {
      const diff = a.amount - b.amount;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    const single = sorted.find(note => note.amount >= target);
    if (single) {
      return [single];
    }
    let bestPair: { total: bigint; notes: Array<{ noteId: string; spendingKey: string; amount: bigint }> } | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      for (let j = i - 1; j >= 0; j--) {
        const total = sorted[i]!.amount + sorted[j]!.amount;
        if (total >= target) {
          if (!bestPair || total < bestPair.total) {
            bestPair = { total, notes: [sorted[i]!, sorted[j]!] };
          }
        }
      }
    }
    if (bestPair) {
      return bestPair.notes;
    }
    throw new Error(`Insufficient notes: need ${target}, have ${sorted.reduce((sum, n) => sum + n.amount, 0n)}`);
  }
  
  const selectedInputNotes = selectNotesForAmount(params.zTokenInputNotes, params.amountIn);
  
  const transferProofIn = await generateDexTransferProofSimple(
    proofClient,
    connection,
    tokenInMint,
    selectedInputNotes,
    params.amountIn,
    poolState, // recipient is pool PDA
    payer // change goes back to user
  );
  
  // Output: pool PDA → user
  // Note: For zToken → zToken swaps, the pool PDA transfers zTokens to the user
  // This requires pool PDA private reserves and note commitments, which is complex
  // For now, we'll need to implement pool PDA note fetching from the commitment tree
  // TODO: Implement pool PDA note/commitment fetching and proof generation
  // The pool PDA signs with seeds, so the proof can be generated client-side
  // but we need to know which commitments the pool has
  
  // Placeholder: Generate a transfer proof with empty inputs for now
  // This will need proper implementation with pool PDA commitment fetching
  const transferProofOut = await generateDexTransferProofSimple(
    proofClient,
    connection,
    tokenOutMint,
    [], // Pool PDA notes - TODO: fetch from pool state commitments
    params.minAmountOut,
    payer, // recipient is user
    payer // change goes back to user
  );
  
  // Convert proofs to TransferArgs
  const transferArgsIn = proofToTransferArgs(transferProofIn);
  const transferArgsOut = proofToTransferArgs(transferProofOut);
  
  // Encode swap instruction
  const swapData = dexCoder.instruction.encode('swap', {
    amount_in: new BN(params.amountIn.toString()),
    min_amount_out: new BN(params.minAmountOut.toString()),
    a_to_b: actualAToB,
    transfer_args_in: transferArgsIn,  // Required: TransferArgs for zToken input
    transfer_args_out: transferArgsOut // Required: TransferArgs for zToken output
  });
  
  // Build instruction keys (both tokens are always zTokens)
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: userTokenInAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenOutAccount, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add zToken pool accounts to remaining_accounts for transfer CPIs
  // Input: user → pool PDA (7 accounts)
  console.info('[swapDex] Adding zToken pool accounts for input transfer (user → pool PDA)');
  const zTokenAccountsIn = getZTokenPoolAccounts(tokenInMint, false); // forShield = false (transfer)
  instructionKeys.push(...zTokenAccountsIn.map(pubkey => ({ 
    pubkey, 
    isSigner: false, 
    isWritable: true
  })));
  
  // Output: pool PDA → user (7 accounts)
  console.info('[swapDex] Adding zToken pool accounts for output transfer (pool PDA → user)');
  const zTokenAccountsOut = getZTokenPoolAccounts(tokenOutMint, false); // forShield = false (transfer)
  instructionKeys.push(...zTokenAccountsOut.map(pubkey => ({ 
    pubkey, 
    isSigner: false, 
    isWritable: true
  })));
  
  // Add payer, system_program, rent to remaining_accounts for CPIs
  instructionKeys.push(
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  );
  
  instructions.push(
    new TransactionInstruction({
      programId: DEX_PROGRAM_ID,
      keys: instructionKeys,
      data: swapData
    })
  );
  
  // Send transaction
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
