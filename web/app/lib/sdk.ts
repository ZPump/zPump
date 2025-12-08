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
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from '@solana/web3.js';
import { WalletContextState } from '@solana/wallet-adapter-react';
import { BorshCoder, BN, Idl, Program, AnchorProvider } from '@coral-xyz/anchor';
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
import { CIRCUIT_TAGS } from './onchain/programIds';

// Re-export deriveDexPoolState for convenience
export { deriveDexPoolState };

/**
 * Resolve a public key from string or PublicKey, with optional fallback
 */
export async function resolvePublicKey(
  key: string | PublicKey | null | undefined,
  fallback?: PublicKey | null
): Promise<PublicKey> {
  if (key instanceof PublicKey) {
    return key;
  }
  if (typeof key === 'string' && key) {
    try {
      return new PublicKey(key);
    } catch {
      // Invalid public key string
    }
  }
  if (fallback) {
    return fallback;
  }
  throw new Error('Invalid public key and no fallback provided');
}
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

function deriveProofVault(owner: PublicKey): PublicKey {
  const [proofVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('proof-vault'), owner.toBuffer()],
    POOL_PROGRAM_ID
  );
  return proofVault;
}

function operationIdHexToArray(operationId: string): number[] {
  const buffer = Buffer.from(operationId, 'hex');
  if (buffer.length !== 32) {
    throw new Error(`Operation ID must be 32 bytes (got ${buffer.length})`);
  }
  return Array.from(buffer);
}

async function fetchOperationIdFromReturnData(
  connection: Connection,
  signature: string
): Promise<Uint8Array> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  });
  // In newer versions of @solana/web3.js, returnData might be on the transaction or meta
  // Try both locations for compatibility
  const returnData = (tx?.transaction as any)?.message?.returnData || 
                     (tx?.meta as any)?.returnData ||
                     (tx as any)?.returnData;
  if (!returnData) {
    throw new Error('prepare transaction did not return operation id');
  }
  const [data, encoding] = returnData.data;
  const buffer = Buffer.from(data, encoding === 'base64' ? 'base64' : encoding);
  if (buffer.length !== 32) {
    throw new Error(`invalid operation id length: expected 32, got ${buffer.length}`);
  }
  return new Uint8Array(buffer);
}

type PrepareResult = {
  operationId: string;
  signature: string;
};

async function sendPrepareInstruction(
  connection: Connection,
  wallet: WalletContextState,
  data: Buffer
): Promise<PrepareResult> {
  const payer = wallet.publicKey;
  if (!payer) {
    throw new Error('Wallet must be connected');
  }

  const proofVault = deriveProofVault(payer);
  const instruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: [
      { pubkey: proofVault, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data
  });

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(instruction);
  tx.feePayer = payer;
  tx.recentBlockhash = latestBlockhash.blockhash;

  const signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });

  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );

  const operationIdBytes = await fetchOperationIdFromReturnData(connection, signature);
  return { operationId: Buffer.from(operationIdBytes).toString('hex'), signature };
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

type PrepareShieldParams = WrapParams;

export interface ExecuteShieldParams extends Omit<WrapParams, 'proof'> {
  operationId: string;
}

type PrepareUnshieldParams = UnwrapParams;

export interface ExecuteUnshieldParams extends Omit<UnwrapParams, 'proof'> {
  operationId: string;
}

type PrepareTransferParams = TransferParams;

export interface ExecuteTransferParams extends Omit<TransferParams, 'proof'> {
  operationId: string;
}

type PrepareTransferFromParams = TransferFromParams;

export interface ExecuteTransferFromParams extends Omit<TransferFromParams, 'proof'> {
  operationId: string;
}

type PrepareBatchTransferParams = BatchTransferParams;

interface BatchTransferFromParams extends BatchTransferParams {
  allowances: Array<{
    allowanceOwner: string;
    allowanceAmount: bigint | number | string;
    spendAmount: bigint | number | string;
  }>;
}

type PrepareBatchTransferFromParams = BatchTransferFromParams;

export interface ExecuteBatchTransferFromParams extends Omit<BatchTransferFromParams, 'batchProof'> {
  operationId: string;
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
  keypair?: Keypair; // Optional keypair for direct transaction signing (matches bootstrap script approach)
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
  console.log('[fetchMintMappingAccount] Looking for mint mapping:', { originMint: originMint.toBase58(), mintMappingKey: key.toBase58() });
  // Try multiple times with increasing confirmation levels in case of timing issues
  let account = await connection.getAccountInfo(key, 'confirmed');
  if (!account) {
    console.log('[fetchMintMappingAccount] Account not found with confirmed, trying finalized...');
    // Retry with 'finalized' confirmation level
    account = await connection.getAccountInfo(key, 'finalized');
  }
  if (!account) {
    console.error('[fetchMintMappingAccount] Account not found after retries:', { key: key.toBase58(), originMint: originMint.toBase58() });
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
  console.log('[fetchMintMappingAccount] ✅ Account found:', { key: key.toBase58(), owner: account.owner.toBase58(), dataLen: account.data.length });
  
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
  poolCoder?: any; // Optional Anchor coder for building instruction
}): TransactionInstruction {
  const FEATURE_PRIVATE_TRANSFER_ENABLED = 1;
  const FEATURE_ALLOWANCES_ENABLED = 2;
  const features = FEATURE_PRIVATE_TRANSFER_ENABLED | FEATURE_ALLOWANCES_ENABLED;
  const feeBps = 0;

  const initPoolData = poolCoder.instruction.encode('initialize_pool', {
    fee_bps: feeBps,
    features
  });

  // CRITICAL FIX: Match bootstrap script behavior exactly
  // The bootstrap script only includes accounts that exist in the mapping
  // Optional accounts are skipped entirely (not included in the instruction)
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
    // twin_mint is NOT included - matches bootstrap script (only added if twinMintKey exists)
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

  // CRITICAL FIX: Use exact same logic as bootstrap script's buildAccountMetas
  // This ensures account order matches what the deployed program expects
  const accounts = ixDef.accounts as InitializePoolAccountDef[];
  const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [];
  
  for (const account of accounts) {
    const pubkey = poolAccounts[account.name];
    if (!pubkey) {
      if (account.optional) {
        // CRITICAL FIX: Include placeholder for optional accounts to preserve positions
        // Anchor matches accounts by position, so skipping optional accounts causes position shifts
        // that break Anchor's Signer constraint validation. By including a placeholder account,
        // we preserve positions while the program treats it as None.
        // For #[account(mut)] optional accounts, the placeholder must also be writable.
        // Use payer's account as placeholder for writable optional accounts (it's already writable and in transaction)
        console.log(`[buildInitializePoolInstruction] Including placeholder for optional account ${account.name} to preserve positions`);
        const placeholderPubkey = account.writable 
          ? args.wallet.publicKey! // Use payer for writable optional accounts (matches bootstrap pattern)
          : SystemProgram.programId; // Use system program for non-writable optional accounts
        keys.push({ 
          pubkey: placeholderPubkey, 
          isSigner: false, 
          isWritable: account.writable ?? false // Must match the account's mutability requirement (twin_mint is mut)
        });
        continue;
      }
      throw new Error(`Missing account mapping for ${account.name}`);
    }
    // Match bootstrap script: use writable/isMut and signer/isSigner logic
    const isWritable = account.writable ?? false;
    // CRITICAL: payer must be a signer (it pays for account initialization)
    // Also check isSigner as fallback for IDL compatibility
    const isSigner = account.name === 'payer' ? true : (account.signer ?? account.isSigner ?? false);
    keys.push({ pubkey, isSigner, isWritable });
  }
  
  // CRITICAL DEBUG: Log account positions and count
  console.log(`[buildInitializePoolInstruction] Total accounts: ${keys.length} (IDL expects ${accounts.length}, skipped ${accounts.length - keys.length} optional)`);
  console.log('[buildInitializePoolInstruction] Account positions:');
  keys.forEach((key, i) => {
    if (key.pubkey.equals(args.originMint) || key.pubkey.equals(args.mintMapping)) {
      console.log(`  [${i}] ${key.pubkey.toBase58()}${key.pubkey.equals(args.originMint) ? ' <- origin_mint' : ' <- mint_mapping'}`);
    }
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
      // Check if we're the authority for this lookup table
      const lookupTableInfo = await connection.getAccountInfo(lookupTableAddress);
      if (!lookupTableInfo) {
        throw new Error(`Lookup table ${lookupTableAddress.toBase58()} not found`);
      }
      
      // Parse lookup table authority (first 32 bytes after discriminator)
      // AddressLookupTable layout: discriminator[8] + deactivationSlot[8] + lastExtendedSlot[8] + authority[32] + ...
      if (lookupTableInfo.data.length < 8 + 8 + 8 + 32) {
        throw new Error(`Invalid lookup table data length: ${lookupTableInfo.data.length}`);
      }
      const authorityBytes = lookupTableInfo.data.slice(24, 56);
      const tableAuthority = new PublicKey(authorityBytes);
      
      // Only extend if we're the authority
      if (tableAuthority.equals(wallet.publicKey!)) {
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
      } else {
        // We're not the authority - log warning and skip extension
        console.warn(`[preparePool] Lookup table ${lookupTableAddress.toBase58()} authority is ${tableAuthority.toBase58()}, but wallet is ${wallet.publicKey!.toBase58()}. Skipping extension.`);
        console.warn(`[preparePool] Missing addresses: ${missingAddresses.map(a => a.toBase58()).join(', ')}`);
        // Continue anyway - the lookup table might already have the addresses we need
        result.actions.push('alt-extension-skipped');
      }
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

  // CRITICAL VALIDATION: Check if pool exists and verify its origin_mint matches
  // If pool exists but was initialized with a different mint, we need to handle it
  if (poolAccount && poolAccount.data.length >= 72) {
    const poolData = Buffer.from(poolAccount.data);
    // PoolState layout: discriminator[8] + authority[32] + origin_mint[32] + ...
    const poolOriginMint = new PublicKey(poolData.slice(40, 72));
    if (!poolOriginMint.equals(originMintKey)) {
      throw new Error(
        `Pool state exists but was initialized with different origin_mint: ` +
        `pool has ${poolOriginMint.toBase58()}, but we need ${originMintKey.toBase58()}. ` +
        `When shielding SOL, ensure the pool is initialized for wSOL (${NATIVE_SOL_MINT.toBase58()}), not native SOL.`
      );
    }
  }
  
  if (!poolAccount) {
    // CRITICAL DEBUG: Log what we're passing to ensure correctness
    console.log('[preparePool] Initializing pool with:');
    console.log(`  originMint: ${originMintKey.toBase58()}`);
    console.log(`  mintMapping: ${mintMappingKey.toBase58()}`);
    console.log(`  poolState: ${poolState.toBase58()}`);
    
    // CRITICAL FIX: Use manual instruction building matching bootstrap script exactly
    // The bootstrap script uses buildAccountMetas which skips optional accounts
    // This causes position shifts, but Anchor's Option<> type handles this correctly
    // by matching accounts by name/type, not strictly by position
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
      tokenProgramId,
      poolCoder
    });
    
    // CRITICAL DEBUG: Verify the instruction accounts match what we expect
    console.log('[preparePool] Instruction accounts (full list):');
    initPoolIx.keys.forEach((key, i) => {
      const isOriginMint = key.pubkey.equals(originMintKey);
      const isMintMapping = key.pubkey.equals(mintMappingKey);
      const isPayer = key.pubkey.equals(wallet.publicKey!);
      if (isOriginMint || isMintMapping || isPayer || i < 3 || i > 15) {
        console.log(`  [${i}] ${key.pubkey.toBase58()} (signer=${key.isSigner}, writable=${key.isWritable})${isOriginMint ? ' <- origin_mint' : ''}${isMintMapping ? ' <- mint_mapping' : ''}${isPayer ? ' <- payer' : ''}`);
      }
    });
    console.log(`[preparePool] Fee payer: ${wallet.publicKey!.toBase58()}`);
    console.log(`[preparePool] Payer in instruction: ${initPoolIx.keys.find(k => k.pubkey.equals(wallet.publicKey!))?.pubkey.toBase58() || 'NOT FOUND'} (signer=${initPoolIx.keys.find(k => k.pubkey.equals(wallet.publicKey!))?.isSigner || false})`);
    
    const initBlockhash = await connection.getLatestBlockhash('confirmed');
    const initTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      initPoolIx
    );
    initTx.feePayer = wallet.publicKey!;
    initTx.recentBlockhash = initBlockhash.blockhash;
    
    // CRITICAL FIX: Match bootstrap script approach exactly
    // The bootstrap script uses transaction.sign(ctx.payer) which signs the transaction directly
    // If keypair is provided, use direct signing (more reliable for optional account handling)
    // Otherwise, fall back to wallet.signTransaction
    let signedTx: Transaction;
    if (params.keypair) {
      // Direct signing with keypair (matches bootstrap script: transaction.sign(ctx.payer))
      initTx.sign(params.keypair);
      signedTx = initTx;
    } else if (wallet.signTransaction) {
      // Use wallet adapter signing
      signedTx = await wallet.signTransaction(initTx);
    } else {
      throw new Error('Wallet must support signTransaction or provide keypair for pool initialization');
    }
    console.log('[preparePool] Transaction signed explicitly - all signer accounts should be signed');
    
    // CRITICAL DEBUG: Verify signatures and account positions before sending
    console.log(`[preparePool] Transaction has ${signedTx.signatures.length} signature(s)`);
    signedTx.signatures.forEach((sig, i) => {
      console.log(`  [${i}] ${sig.publicKey.toBase58()}: ${sig.signature ? 'SIGNED' : 'NOT SIGNED'}`);
    });
    
    // CRITICAL DEBUG: Verify payer account position in instruction
    const payerKeyIndex = initPoolIx.keys.findIndex(k => k.pubkey.equals(wallet.publicKey!) && k.isSigner);
    console.log(`[preparePool] Payer account found at instruction key index: ${payerKeyIndex >= 0 ? payerKeyIndex : 'NOT FOUND'}`);
    if (payerKeyIndex >= 0) {
      const payerKey = initPoolIx.keys[payerKeyIndex];
      console.log(`[preparePool] Payer key details: signer=${payerKey.isSigner}, writable=${payerKey.isWritable}`);
    }
    
    // CRITICAL DEBUG: Simulate first to see what the program receives
    try {
      const simulation = await connection.simulateTransaction(signedTx, {
        replaceRecentBlockhash: true,
        sigVerify: false
      });
      if (simulation.value.err) {
        console.error('[preparePool] Simulation error:', simulation.value.err);
        console.error('[preparePool] Simulation logs:', simulation.value.logs);
        // Check if the error is specifically about payer not being a signer
        const logs = simulation.value.logs || [];
        const payerError = logs.find((log: string) => log.includes('payer') && log.includes('AccountNotSigner'));
        if (payerError) {
          console.error('[preparePool] CRITICAL: Payer AccountNotSigner error detected in simulation');
          console.error('[preparePool] This suggests the transaction is not properly signed for the payer account');
        }
      }
    } catch (simError) {
      console.warn('[preparePool] Simulation failed (non-fatal):', simError);
    }
    
    // Send raw transaction (matching bootstrap script approach: sendRawTransaction)
    const initSig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
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

export type PrepareShieldResult = PrepareResult;

export async function prepareShield(params: PrepareShieldParams): Promise<PrepareShieldResult> {
  assertWallet(params.wallet);
  if (!params.proof) {
    throw new Error('Proof is required for prepareShield');
  }

  const wallet = params.wallet;
  const connection = params.connection;
  const amount = params.amount;
  const blinding = BigInt(params.blinding);
  const amountCommitmentBytes = await poseidonHashMany([amount, blinding]);

  const decodedProof = decodeProofPayload(params.proof);
  if (decodedProof.fields.length < 2) {
    throw new Error('Shield proof missing public inputs');
  }

  const shieldArgs = {
    amount_commit: Array.from(amountCommitmentBytes),
    amount: new BN(amount.toString()),
    proof: Buffer.from(decodedProof.proof),
    public_inputs: Buffer.from(decodedProof.publicInputs)
  };

  return sendPrepareInstruction(
    connection,
    wallet,
    poolCoder.instruction.encode('prepare_shield', { shield_args: shieldArgs })
  );
}

export async function executeShield(params: ExecuteShieldParams): Promise<string> {
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
  // CRITICAL FIX: When shielding SOL, derive poolState from wSOL mint, not from params.poolId
  // params.poolId might be for native SOL, but we need wSOL pool
  const poolState = isShieldingSOL 
    ? derivePoolState(actualShieldMint) // Use wSOL pool when shielding SOL
    : new PublicKey(params.poolId); // Use provided poolId for other tokens
  const commitmentTreeKey = deriveCommitmentTree(actualShieldMint);
  const nullifierSet = deriveNullifierSet(actualShieldMint);
  const noteLedger = deriveNoteLedger(actualShieldMint);
  const hookConfig = deriveHookConfig(actualShieldMint);
  const hookWhitelist = deriveHookWhitelist(actualShieldMint);
  const vaultState = deriveVaultState(actualShieldMint);
  const proofVault = deriveProofVault(wallet.publicKey!);
  const verifyingKey = deriveVerifyingKey();
  const shieldClaim = deriveShieldClaim(poolState);
  const factoryState = deriveFactoryState(); // Needed for lazy initialization
  const twinMintKey = params.twinMint ? new PublicKey(params.twinMint) : null;
  
  // CRITICAL: Fetch mint mapping using actualShieldMint (wSOL if SOL was detected)
  // This ensures we get the correct mint mapping for the pool we're actually using
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    actualShieldMint // Use actualShieldMint (wSOL if SOL was detected)
  );
  
  // CRITICAL VALIDATION: Ensure poolState matches the derived pool for actualShieldMint
  // This prevents using a pool initialized for a different mint (e.g., native SOL vs wSOL)
  const expectedPoolState = derivePoolState(actualShieldMint);
  if (!poolState.equals(expectedPoolState)) {
    throw new Error(
      `Pool state mismatch: provided poolId ${poolState.toBase58()} does not match expected pool for mint ${actualShieldMint.toBase58()} (expected: ${expectedPoolState.toBase58()}). ` +
      `When shielding SOL, ensure you use the wSOL pool, not the native SOL pool.`
    );
  }
  ensureMintActive(mintMapping);
  
  // Store mintMapping for later use (ALT lookup)
  
  // Wait for pending_shield to be inactive before starting a new shield
  // This prevents PendingShieldInFlight errors from previous incomplete operations
  // LAZY INITIALIZATION: If pool doesn't exist yet, pending_shield can't be active
  // CRITICAL FIX: execute_shield has built-in logic to clear stuck pending_shield states,
  // so we don't need to wait or manually clear it - just proceed and let execute_shield handle it
  try {
    await waitForPendingShieldInactive(connection, poolState, 2000); // Short timeout - just check
  } catch (error) {
    // pending_shield is still active - this is OK because execute_shield will clear it
    // The program's execute_shield function has logic to deactivate stuck pending_shield
    // states (see programs/pool/src/lib.rs lines 1414-1436)
    console.info('[wrap] pending_shield is active, but execute_shield will clear it if stuck');
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
  
  // CRITICAL: Verify all accounts exist before calling execute_shield
  // Anchor's validation might crash if accounts don't exist, even for UncheckedAccount
  console.log('[executeShield] Verifying all accounts exist before instruction...');
  const proofVaultAccount = await connection.getAccountInfo(proofVault, 'confirmed');
  if (!proofVaultAccount) {
    throw new Error(`Proof vault account does not exist: ${proofVault.toBase58()}. Run prepareShield first.`);
  }
  console.log('[executeShield] ✓ Proof vault exists');
  
  // Verify system_program and rent sysvar (these should always exist, but check anyway)
  const systemProgramAccount = await connection.getAccountInfo(SystemProgram.programId, 'confirmed');
  if (!systemProgramAccount) {
    throw new Error('System program account not found - this should never happen');
  }
  const rentAccount = await connection.getAccountInfo(SYSVAR_RENT_PUBKEY, 'confirmed');
  if (!rentAccount) {
    throw new Error('Rent sysvar account not found - this should never happen');
  }
  console.log('[executeShield] ✓ System program and rent sysvar exist');
  
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
    // Increased default for shield with SOL wrapping (multiple token account creations)
    // Further increased to handle proof verification and account operations
    return 3_000_000;
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

  // SOL WRAPPING: Optimized - only wrap if absolutely necessary
  // The wrap() function handles wrapping in a separate transaction for better efficiency
  // When executeShield is called directly (e.g., in tests), we check if wrapping is needed
  if (isShieldingSOL && wsolTokenAccount) {
    const balanceCheck = await checkWrappedSolBalance(connection, wallet.publicKey!, amount);
    
    if (!balanceCheck.hasEnough) {
      // Need to wrap - but this makes the transaction expensive
      // Ideally, wrapping should be done before executeShield (as wrap() function does)
      console.warn(`[executeShield] wSOL balance insufficient (${balanceCheck.currentBalance} < ${amount}) - wrapping in executeShield (not optimal)`);
      const wsolAccountInfo = await connection.getAccountInfo(wsolTokenAccount, 'confirmed');
      if (!wsolAccountInfo) {
        instructions.push(createAssociatedTokenAccountInstruction(
          wallet.publicKey!,
          wsolTokenAccount,
          wallet.publicKey!,
          NATIVE_SOL_MINT,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ));
      }
    const wrapInstructions = await createWrapSolInstructions(
      wsolTokenAccount,
        balanceCheck.needsWrap,
      wallet.publicKey,
      connection
    );
      // Remove duplicate create ATA if we already added it
      if (!wsolAccountInfo) {
        instructions.push(...wrapInstructions.filter(ix => 
          !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
        ));
      } else {
    instructions.push(...wrapInstructions);
      }
    } else {
      // wSOL exists with sufficient balance - skip all wrapping (this is the optimal path)
      console.log(`[executeShield] ✅ wSOL has sufficient balance (${balanceCheck.currentBalance} >= ${amount}) - skipping wrap`);
    }
  }

  // OPTIMIZATION: Account creation should happen BEFORE executeShield to reduce transaction size
  // Check if accounts exist, and if not, throw an error (don't create them here)
  // The wrap() function or prepareShield() should ensure accounts exist
  const vaultTokenAccountInfo = await connection.getAccountInfo(vaultTokenAccount, 'confirmed');
  if (!vaultTokenAccountInfo) {
    throw new Error(`Vault token account does not exist. Accounts should be created before calling executeShield. Use wrap() function or ensure accounts are created first.`);
  }
  
  // Depositor account should also exist (for SOL, it's wSOL which should be wrapped before)
  // For non-SOL, it should be created before executeShield
  if (!isShieldingSOL) {
    const depositorInfo = await connection.getAccountInfo(depositorTokenAccount, 'confirmed');
    if (!depositorInfo) {
      throw new Error(`Depositor token account does not exist. Accounts should be created before calling executeShield.`);
    }
  }

  const finalizeTreeData = poolCoder.instruction.encode('shield_finalize_tree', {});
  const finalizeLedgerData = poolCoder.instruction.encode('shield_finalize_ledger', {});
  const checkInvariantData = poolCoder.instruction.encode('shield_check_invariant', {});
  // WORKAROUND TEST: Renamed from execute_shield to shield_execute to test if instruction name causes access violation
  const shieldData = poolCoder.instruction.encode('shield_execute', {
    operation_id: operationIdHexToArray(params.operationId)
  });

  // CRITICAL FIX: Reduced to 4 accounts to prevent stack overflow (matching ExecuteTransfer pattern)
  // ExecuteShield struct now has 4 accounts: payer, proof_vault, system_program, rent
  // pool_state, commitment_tree, and origin_mint are moved to remaining_accounts to reduce stack usage
  const shieldKeys = [
    { pubkey: wallet.publicKey!, isSigner: true, isWritable: true }, // payer (FIRST in struct)
    { pubkey: proofVault, isSigner: false, isWritable: true }, // proof_vault (SECOND in struct)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program (THIRD in struct)
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent (FOURTH in struct)
  ];

  // Remaining accounts - pool_state, commitment_tree, origin_mint moved here to reduce stack usage
  const remainingAccounts = [
    { pubkey: poolState, isSigner: false, isWritable: true }, // pool_state (moved from struct)
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true }, // commitment_tree (moved from struct)
    { pubkey: actualShieldMint, isSigner: false, isWritable: false }, // origin_mint (moved from struct)
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: hookWhitelist, isSigner: false, isWritable: true },
    { pubkey: nullifierSet, isSigner: false, isWritable: true },
    { pubkey: noteLedger, isSigner: false, isWritable: true },
    { pubkey: vaultState, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
  ];

  if (twinMintKey) {
    remainingAccounts.push({ pubkey: twinMintKey, isSigner: false, isWritable: true });
  }

  remainingAccounts.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: shieldClaim, isSigner: false, isWritable: true },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: factoryState, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tokenProgramId, isSigner: false, isWritable: false }
  );

  // CRITICAL: shieldKeys now contains all struct accounts in IDL order:
  // 1. pool_state, 2. commitment_tree, 3. payer, 4. origin_mint, 5. proof_vault, 6. system_program, 7. rent, 8. clock
  // remainingAccounts contains all accounts after the struct accounts
  // CRITICAL: Restore working pattern - use manual instruction building matching the restored struct
  // The struct now has 7 accounts: pool_state, commitment_tree, payer, origin_mint, proof_vault, system_program, rent
  const allShieldKeys = [...shieldKeys, ...remainingAccounts];
  const shieldInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: allShieldKeys,
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

  // CRITICAL: Force regular Transaction (matching executeTransfer pattern) to avoid access violation
  // VersionedTransaction might be causing issues with Anchor's account validation
  let lookupTableAddress: PublicKey | null = null;
  let lookupTableAccount: any = null;
  
  // Temporarily disable lookup table to match executeTransfer pattern
  // if (mintMapping.lookupTable) {
  //   lookupTableAddress = mintMapping.lookupTable;
  //   try {
  //     const lookupTableResult = await connection.getAddressLookupTable(lookupTableAddress);
  //     if (lookupTableResult.value) {
  //       lookupTableAccount = lookupTableResult.value;
  //     }
  //   } catch (error) {
  //     console.warn(`[wrap] Failed to fetch lookup table ${lookupTableAddress.toBase58()}:`, error instanceof Error ? error.message : String(error));
  //     // Continue without lookup table - will use regular Transaction
  //     lookupTableAddress = null;
  //     lookupTableAccount = null;
  //   }
  // }

  let latestBlockhash = await connection.getLatestBlockhash('confirmed');
  
  // Compute budget is already added to instructions array above (lines 1624-1634)
  // No need to add it again here
  
  const shieldInstructionSet = [...instructions, shieldInstruction];

  let shieldSignature: string | undefined;
  let shieldAttempts = 0;
  const maxShieldAttempts = 5;
  
  // Retry shield if it fails with PendingShieldInFlight (0x1793 = 6035)
  while (shieldAttempts < maxShieldAttempts) {
    shieldAttempts++;
    try {
      let shieldTransaction: Transaction | VersionedTransaction | null = null;
      
      // CRITICAL: Force regular Transaction to match executeTransfer pattern and avoid access violation
      if (false && lookupTableAccount && lookupTableAddress) {
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
          } catch (signError) {
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
            } catch (keypairError) {
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
            } catch (txError) {
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
        let useSkipPreflight = false;
        if (txSize > maxTxSize) {
          // Transaction too large - try with skipPreflight for slightly oversized transactions
          // For first shield (before lookup table exists), allow up to 1400 bytes
          if (txSize > 1400) {
            // Transaction is way too large - cannot proceed without ALT
            throw new Error(`Transaction too large (${txSize} bytes > 1232). Address Lookup Table required but not available.`);
          }
          console.warn(`[wrap] Transaction slightly oversized (${txSize} bytes), using skipPreflight: true`);
          useSkipPreflight = true;
        }
        
        // Recreate transaction for sending (wallet.sendTransaction will sign it)
        const txForSending = new Transaction().add(...shieldInstructionSet);
        txForSending.feePayer = wallet.publicKey;
        txForSending.recentBlockhash = latestBlockhash.blockhash;
        
        try {
          shieldSignature = await wallet.sendTransaction(txForSending, connection, {
            skipPreflight: useSkipPreflight || txSize > maxTxSize // Use skipPreflight for oversized transactions
          });
        } catch (txError) {
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
    } catch (error) {
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
          
          console.info('[wrap] Pending shield cleared, retrying execute_shield with stored proof data...');
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
  // We need to call finalize_tree for any of these statuses
  // CRITICAL FIX: Also check if pending_shield is active even if claim is INACTIVE (stuck state)
  let poolStateAccount = await connection.getAccountInfo(poolState, 'confirmed');
  let pendingShieldActive = false;
  if (poolStateAccount) {
    try {
      const decoded = poolCoder.accounts.decode('PoolState', poolStateAccount.data) as {
        pendingShield?: { active?: number };
        pending_shield?: { active?: number };
      };
      const pendingShield = decoded.pendingShield ?? decoded.pending_shield;
      pendingShieldActive = pendingShield?.active !== undefined && pendingShield.active !== 0;
    } catch (error) {
      // If decoding fails, read pending_shield.active byte directly
      const accountData = Buffer.from(poolStateAccount.data);
      const PENDING_SHIELD_ACTIVE_OFFSET = 1697; // From waitForPendingShieldInactive
      if (accountData.length > PENDING_SHIELD_ACTIVE_OFFSET) {
        const activeByte = accountData[PENDING_SHIELD_ACTIVE_OFFSET];
        pendingShieldActive = activeByte !== undefined && activeByte !== 0;
      }
    }
  }
  
  while (claimState.status === SHIELD_CLAIM_STATUS.PENDING_TREE 
      || claimState.status === SHIELD_CLAIM_STATUS.AWAITING_LEDGER
      || claimState.status === SHIELD_CLAIM_STATUS.AWAITING_INVARIANT
      || (claimState.status === SHIELD_CLAIM_STATUS.INACTIVE && pendingShieldActive)) {
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
    
    // Recheck both claim state and pending_shield
    claimState = await fetchShieldClaimState(connection, shieldClaim);
    poolStateAccount = await connection.getAccountInfo(poolState, 'confirmed');
    if (poolStateAccount) {
      try {
        const decoded = poolCoder.accounts.decode('PoolState', poolStateAccount.data) as {
          pendingShield?: { active?: number };
          pending_shield?: { active?: number };
        };
        const pendingShield = decoded.pendingShield ?? decoded.pending_shield;
        pendingShieldActive = pendingShield?.active !== undefined && pendingShield.active !== 0;
      } catch (error) {
        const accountData = Buffer.from(poolStateAccount.data);
        const PENDING_SHIELD_ACTIVE_OFFSET = 1697;
        if (accountData.length > PENDING_SHIELD_ACTIVE_OFFSET) {
          const activeByte = accountData[PENDING_SHIELD_ACTIVE_OFFSET];
          pendingShieldActive = activeByte !== undefined && activeByte !== 0;
        } else {
          pendingShieldActive = false;
        }
      }
    } else {
      pendingShieldActive = false;
    }
    
    // Break if both are inactive
    if (claimState.status === SHIELD_CLAIM_STATUS.INACTIVE && !pendingShieldActive) {
      break;
    }
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

export type PrepareUnshieldResult = PrepareResult;

export async function prepareUnshield(params: PrepareUnshieldParams): Promise<PrepareUnshieldResult> {
  assertWallet(params.wallet);
  const { wallet, connection } = params;
  const originMintKey = new PublicKey(params.originMint);
  const poolStateKey = new PublicKey(params.poolId);
  
  const poolStateAccount = await connection.getAccountInfo(poolStateKey);
  if (!poolStateAccount) {
    throw new Error('Pool state account missing');
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
  
  const hasChange = decodedProof.fields.length >= (2 + nullifierCount + CHANGE_FIELD_COUNT + TRAILING_FIELD_COUNT);
  
  let changeCommitmentBytes: Uint8Array | null = null;
  let changeAmountCommitmentBytes: Uint8Array | null = null;
  let fieldOffset = 2 + nullifierCount;
  
  if (hasChange) {
    changeCommitmentBytes = decodedProof.fields[fieldOffset];
    changeAmountCommitmentBytes = decodedProof.fields[fieldOffset + 1];
  }

  const oldRootCanonical = bytesLEToCanonicalHex(oldRootBytes);
  if (oldRootCanonical !== poolRootCanonical) {
    throw new Error('Commitment tree root mismatch. Refresh notes and try again.');
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

  return sendPrepareInstruction(
    connection,
    wallet,
    poolCoder.instruction.encode('prepare_unshield', { unshield_args: unshieldArgs })
  );
}

export interface ExecuteUnshieldParams extends Omit<UnwrapParams, 'proof'> {
  operationId: string;
}

export async function executeUnshield(params: ExecuteUnshieldParams): Promise<string> {
  assertWallet(params.wallet);
  const { wallet, connection } = params;
  const originMintKey = new PublicKey(params.originMint);
  const poolStateKey = new PublicKey(params.poolId);
  const destinationKey = new PublicKey(params.destination);

  const mode = params.mode === 'ztkn' ? 'ptkn' : params.mode;
  
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const nullifierSetKey = deriveNullifierSet(originMintKey);
  const noteLedgerKey = deriveNoteLedger(originMintKey);
  const hookConfigKey = deriveHookConfig(originMintKey);
  const hookWhitelistKey = deriveHookWhitelist(originMintKey);
  const vaultStateKey = deriveVaultState(originMintKey);
  const factoryStateKey = deriveFactoryState();
  const verifyingKey = deriveVerifyingKey(CIRCUIT_TAGS.unshield);

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
  
  if (mintMapping.hasPtkn) {
    const candidate = new PublicKey(mintMapping.ptknMint);
    if (candidate.equals(PublicKey.default)) {
      throw new Error('Twin mint address missing from mint mapping.');
    }
    if (twinMintKey && !twinMintKey.equals(candidate)) {
      console.warn('[executeUnshield] twin mint mismatch', {
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

  const poolCoder = new BorshCoder(poolIdl as Idl);
  const proofVault = deriveProofVault(wallet.publicKey!);

  const instructions: TransactionInstruction[] = [];
  
  const computeLimitEnv =
    process.env.UNWRAP_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_UNWRAP_COMPUTE_UNIT_LIMIT ??
    process.env.WRAP_COMPUTE_UNIT_LIMIT ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_LIMIT;
  const resolvedLimit = (() => {
    if (computeLimitEnv !== undefined) {
      const parsed = Number(computeLimitEnv);
      if (!Number.isNaN(parsed)) {
        return Math.max(parsed, 0);
      }
    }
    // Increased default for shield with SOL wrapping (multiple token account creations)
    // Further increased to handle proof verification and account operations
    return 3_000_000;
  })();
  if (resolvedLimit > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedLimit }));
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

  // CRITICAL: Account order must match IDL exactly:
  // 1. pool_state (writable)
  // 2. payer (writable, signer)
  // 3. proof_vault (writable)
  // 4. system_program
  // 5. rent
  // Then remaining_accounts in the order expected by the program
  const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true }, // 1. pool_state
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // 2. payer
    { pubkey: proofVault, isSigner: false, isWritable: true }, // 3. proof_vault
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 4. system_program
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // 5. rent
    // Remaining accounts (remaining_accounts)
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

  if (redeemToTwin && twinMintKey) {
    keys.push({
      pubkey: twinMintKey,
      isSigner: false,
      isWritable: true
    });
  } else {
    keys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  keys.push(
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: factoryStateKey, isSigner: false, isWritable: false },
    { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: originTokenProgram, isSigner: false, isWritable: false }
  );

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys,
      data: poolCoder.instruction.encode('execute_unshield', {
        operation_id: operationIdHexToArray(params.operationId),
        mode: mode === 'ptkn' ? { Twin: {} } : { Origin: {} }
      })
    })
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(...instructions);
  tx.feePayer = wallet.publicKey;
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

export async function unwrap(params: UnwrapParams): Promise<string> {
  const { operationId } = await prepareUnshield(params);
  // eslint-disable-next-line no-unused-vars
  const { proof: _proof, ...executeParams } = params;
  
  const signature = await executeUnshield({ ...executeParams, operationId });
  
  // SOL UNWRAPPING: If unshielding to SOL, unwrap wSOL to native SOL
  const { wallet, connection } = params;
  const originMintKey = new PublicKey(params.originMint);
  const destinationKey = new PublicKey(params.destination);
  const mode = params.mode === 'ztkn' ? 'ptkn' : params.mode;
  
  const { decoded: mintMapping } = await fetchMintMappingAccount(connection, originMintKey);
  let twinMintKey: PublicKey | null = params.twinMint ? new PublicKey(params.twinMint) : null;
  
  if (mintMapping.hasPtkn) {
    const candidate = new PublicKey(mintMapping.ptknMint);
    if (!candidate.equals(PublicKey.default)) {
      twinMintKey = candidate;
    }
  }
  
  const redeemToTwin = mode === 'ptkn';
  const destinationMint = redeemToTwin ? twinMintKey! : originMintKey;
  const isUnshieldingToSOL = isNativeSol(destinationMint);
  
  if (isUnshieldingToSOL) {
    console.log('[unwrap] 🔄 Unshielding to SOL complete, now unwrapping wSOL to native SOL');
    
    try {
      const wsolTokenAccountForUnwrap = await getWrappedSolAccount(destinationKey);
      const unwrapInstruction = createUnwrapSolInstruction(
        wsolTokenAccountForUnwrap,
        destinationKey
      );
      
      const unwrapBlockhash = await connection.getLatestBlockhash('confirmed');
      const unwrapTransaction = new Transaction({
        feePayer: wallet.publicKey || undefined,
        recentBlockhash: unwrapBlockhash.blockhash
      }).add(unwrapInstruction);
      
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
      return unwrapSignature;
    } catch (unwrapError) {
      console.error('[unwrap] ❌ Failed to unwrap wSOL to SOL:', unwrapError);
      console.error('[unwrap] ⚠️ Unshield succeeded but unwrap failed - user has wSOL instead of SOL');
      // Don't throw - unshield succeeded
    }
  }
  
  return signature;
}

export async function wrap(params: WrapParams): Promise<string> {
  // OPTIMIZATION: Handle SOL wrapping BEFORE prepareShield to reduce executeShield transaction size
  // This matches the old behavior where wrap did everything in one transaction, but now we split it
  // to avoid making executeShield too expensive
  const wallet = params.wallet;
  const connection = params.connection;
  let originMintKey = new PublicKey(params.originMint);
  const isShieldingSOL = isNativeSol(originMintKey);
  // Use wSOL mint if shielding SOL, otherwise use original mint
  const actualShieldMint = isShieldingSOL ? NATIVE_SOL_MINT : originMintKey;
  
  // If shielding SOL, wrap it to wSOL first in a separate transaction
  // This reduces the size and compute cost of executeShield
  if (isShieldingSOL) {
    const wsolTokenAccount = await getWrappedSolAccount(wallet.publicKey!);
    
    // Get wrap instructions (createWrapSolInstructions handles ATA creation if needed)
    const wrapInstructions = await createWrapSolInstructions(
      wsolTokenAccount,
      params.amount,
      wallet.publicKey!,
      connection
    );
    
    // Send wrapping transaction separately
    if (wrapInstructions.length > 0) {
      const wrapTx = new Transaction({
        feePayer: wallet.publicKey || undefined
      }).add(...wrapInstructions);
      const wrapBlockhash = await connection.getLatestBlockhash('confirmed');
      wrapTx.recentBlockhash = wrapBlockhash.blockhash;
      
      const wrapSig = await wallet.sendTransaction(wrapTx, connection, { skipPreflight: false });
      await waitForSignatureConfirmation(
        connection,
        wrapSig,
        wrapBlockhash.blockhash,
        wrapBlockhash.lastValidBlockHeight
      );
      console.log('[wrap] ✅ SOL wrapped to wSOL in separate transaction:', wrapSig);
    }
  }
  
  // Derive vault state and determine token program
  const vaultState = deriveVaultState(actualShieldMint);
  const mintAccount = await connection.getAccountInfo(actualShieldMint, 'confirmed');
  if (!mintAccount) {
    throw new Error('Mint account not found');
  }
  const tokenProgramId = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) 
    ? TOKEN_2022_PROGRAM_ID 
    : TOKEN_PROGRAM_ID;
  
  // Ensure vault token account exists before executeShield (reduces executeShield transaction size)
  // This matches the old behavior where wrap did everything in one transaction
  const vaultTokenAccount = await getAssociatedTokenAddress(
    actualShieldMint,
    vaultState,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const vaultTokenAccountInfo = await connection.getAccountInfo(vaultTokenAccount, 'confirmed');
  if (!vaultTokenAccountInfo) {
    // Create vault token account in a separate transaction before executeShield
    console.log('[wrap] Creating vault token account before executeShield...');
    const createVaultTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey!,
        vaultTokenAccount,
        vaultState,
        actualShieldMint,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    createVaultTx.feePayer = wallet.publicKey || undefined;
    const createVaultBlockhash = await connection.getLatestBlockhash('confirmed');
    createVaultTx.recentBlockhash = createVaultBlockhash.blockhash;
    const createVaultSig = await wallet.sendTransaction(createVaultTx, connection, { skipPreflight: false });
    await waitForSignatureConfirmation(
      connection,
      createVaultSig,
      createVaultBlockhash.blockhash,
      createVaultBlockhash.lastValidBlockHeight
    );
    console.log('[wrap] ✅ Vault token account created:', createVaultSig);
  }
  
  // Now prepare and execute shield (executeShield won't need to create accounts or wrap SOL)
  const { operationId } = await prepareShield(params);
  // eslint-disable-next-line no-unused-vars
  const { proof: _proof, ...executeParams } = params;
  return executeShield({ ...executeParams, operationId });
}

export type PrepareTransferResult = PrepareResult;

export async function prepareTransfer(params: PrepareTransferParams): Promise<PrepareTransferResult> {
  assertWallet(params.wallet);
  if (params.outputCommitments.length !== params.outputAmountCommitments.length) {
    throw new Error('Output commitment set mismatch');
  }

  const decodedProof = decodeProofPayload(params.proof);
  if (decodedProof.fields.length < 4) {
    throw new Error('Transfer proof missing public inputs');
  }

  const expectedFieldCount =
    2 + params.nullifiers.length + params.outputCommitments.length + 2;
  if (decodedProof.fields.length !== expectedFieldCount) {
    console.warn('[prepareTransfer] unexpected public input count', {
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

  return sendPrepareInstruction(
    params.connection,
    params.wallet,
    poolCoder.instruction.encode('prepare_transfer', { transfer_args: transferArgs })
  );
}

export async function executeTransfer(params: ExecuteTransferParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const payer = wallet.publicKey;
  if (!payer) {
    throw new Error('Wallet public key missing');
  }
  const poolStateKey = new PublicKey(params.poolId);
  const originMintKey = new PublicKey(params.originMint);
  const commitmentTreeKey = deriveCommitmentTree(originMintKey);
  const nullifierSetKey = deriveNullifierSet(originMintKey);
  const noteLedgerKey = deriveNoteLedger(originMintKey);
  const verifyingKey = deriveVerifyingKey(CIRCUIT_TAGS.transfer);
  const { key: mintMappingKey, decoded: mintMapping } = await fetchMintMappingAccount(
    connection,
    originMintKey
  );
  ensureMintActive(mintMapping);

  const proofVault = deriveProofVault(wallet.publicKey!);

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

  // Build execute_transfer instruction
  // Account order matches ExecuteTransfer struct: payer, proof_vault, system_program, rent
  // All other accounts go in remaining_accounts
  const instructionKeys = [
    { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: proofVault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add remaining accounts (pool_state, nullifier_set, commitment_tree, note_ledger, mint_mapping, verifier_program, verifying_key)
  instructionKeys.push(
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
    { pubkey: mintMappingKey, isSigner: false, isWritable: false },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false }
  );

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: instructionKeys,
      data: poolCoder.instruction.encode('execute_transfer', {
        operation_id: operationIdHexToArray(params.operationId)
      })
    })
  );
  
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

export async function transfer(params: TransferParams): Promise<string> {
  const { operationId } = await prepareTransfer(params);
  // eslint-disable-next-line no-unused-vars
  const { proof: _proof, ...executeParams } = params;
  return executeTransfer({ ...executeParams, operationId });
}

export type PrepareTransferFromResult = PrepareResult;

export async function prepareTransferFrom(params: PrepareTransferFromParams): Promise<PrepareTransferFromResult> {
  assertWallet(params.wallet);
  if (params.outputCommitments.length !== params.outputAmountCommitments.length) {
    throw new Error('Output commitment set mismatch');
  }

  const decodedProof = decodeProofPayload(params.proof);
  if (decodedProof.fields.length < 4) {
    throw new Error('Transfer proof missing public inputs');
  }

  const expectedFieldCount =
    2 + params.nullifiers.length + params.outputCommitments.length + 2;
  if (decodedProof.fields.length !== expectedFieldCount) {
    console.warn('[prepareTransferFrom] unexpected public input count', {
      expectedFieldCount,
      actual: decodedProof.fields.length
    });
  }

  // Create TransferArgs (same as prepareTransfer)
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

  // Create TransferFromArgs with allowance info
  // Calculate spend_amount from output commitments (sum of outputs to others, excluding change)
  // For now, we'll use allowance_amount as spend_amount (caller should ensure they match)
  const transferFromArgs = {
    transfer: transferArgs,
    allowance_amount: new BN(params.allowanceAmount.toString()),
    spend_amount: new BN(params.spendAmount?.toString() ?? params.allowanceAmount.toString())
  };

  return sendPrepareInstruction(
    params.connection,
    params.wallet,
    poolCoder.instruction.encode('prepare_transfer_from', { transfer_args: transferFromArgs })
  );
}

export async function executeTransferFrom(params: ExecuteTransferFromParams): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const spender = wallet.publicKey;
  if (!spender) {
    throw new Error('Wallet public key missing');
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

  const allowanceOwner = new PublicKey(params.allowanceOwner);
  const allowanceKey = deriveAllowanceAccount(poolStateKey, allowanceOwner, spender);
  const proofVault = deriveProofVault(wallet.publicKey!);

  const instructions: TransactionInstruction[] = [];
  const computeLimitEnv =
    process.env.TRANSFER_FROM_COMPUTE_UNIT_LIMIT ??
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
    process.env.TRANSFER_FROM_COMPUTE_UNIT_PRICE ??
    process.env.TRANSFER_COMPUTE_UNIT_PRICE ??
    process.env.WRAP_COMPUTE_UNIT_PRICE ??
    process.env.NEXT_PUBLIC_WRAP_COMPUTE_UNIT_PRICE;
  if (computePriceEnv) {
    const microLamports = Number(computePriceEnv);
    if (!Number.isNaN(microLamports) && microLamports > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    }
  }

  // Build execute_transfer_from instruction
  // Account order matches ExecuteTransferFrom struct: spender, proof_vault, system_program, rent
  // All other accounts go in remaining_accounts
  const instructionKeys = [
    { pubkey: spender, isSigner: true, isWritable: true },
        { pubkey: proofVault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add remaining accounts (pool_state, nullifier_set, commitment_tree, note_ledger, mint_mapping, verifier_program, verifying_key, allowance, allowance_owner)
  instructionKeys.push(
        { pubkey: poolStateKey, isSigner: false, isWritable: true },
        { pubkey: nullifierSetKey, isSigner: false, isWritable: true },
        { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
        { pubkey: noteLedgerKey, isSigner: false, isWritable: true },
        { pubkey: mintMappingKey, isSigner: false, isWritable: false },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: allowanceKey, isSigner: false, isWritable: true },
    { pubkey: allowanceOwner, isSigner: false, isWritable: false }
  );

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: instructionKeys,
      data: poolCoder.instruction.encode('execute_transfer_from', {
        operation_id: operationIdHexToArray(params.operationId)
      })
    })
  );

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

export async function transferFrom(params: TransferFromParams): Promise<string> {
  const { operationId } = await prepareTransferFrom(params);
  // eslint-disable-next-line no-unused-vars
  const { proof: _proof, ...executeParams } = params;
  return executeTransferFrom({ ...executeParams, operationId });
}

export type PrepareBatchTransferResult = PrepareResult;

export async function prepareBatchTransfer(
  params: PrepareBatchTransferParams
): Promise<PrepareBatchTransferResult> {
  assertWallet(params.wallet);
  
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
    console.log(`[prepareBatchTransfer] Transfer 0: Optimizing away zero second output (saves 64 bytes)`);
  }
  if (isSecondOutputZero1) {
    console.log(`[prepareBatchTransfer] Transfer 1: Optimizing away zero second output (saves 64 bytes)`);
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
  
  return sendPrepareInstruction(
    params.connection,
    params.wallet,
    poolCoder.instruction.encode('prepare_batch_transfer', { batch_args: batchTransferArgs })
  );
}

export interface ExecuteBatchTransferParams {
  connection: Connection;
  wallet: WalletContextState;
  operationId: string;
  transfers: Array<{
    originMint: string;
    poolId: string;
  }>;
  keypair?: Keypair;
}

export async function executeBatchTransfer(
  params: ExecuteBatchTransferParams
): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const payer = wallet.publicKey;
  if (!payer) {
    throw new Error('Wallet public key missing');
  }
  
  if (params.transfers.length !== 2) {
    throw new Error('Currently only 2 transfers are supported');
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
  const proofVault = deriveProofVault(wallet.publicKey!);
  
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
  
  // Build execute_batch_transfer instruction
  // Account order matches ExecuteBatchTransfer struct: payer, proof_vault, system_program, rent
  // All other accounts go in remaining_accounts
  const instructionKeys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: proofVault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add remaining accounts:
  // Pool 0: pool_state_0, nullifier_set_0, commitment_tree_0, note_ledger_0, mint_mapping_0
  // Shared: verifier_program, verifying_key
  // Pool 1: pool_state_1, nullifier_set_1, commitment_tree_1, note_ledger_1, mint_mapping_1
  instructionKeys.push(
    { pubkey: poolState0Key, isSigner: false, isWritable: true },
    { pubkey: nullifierSet0Key, isSigner: false, isWritable: true },
    { pubkey: commitmentTree0Key, isSigner: false, isWritable: true },
    { pubkey: noteLedger0Key, isSigner: false, isWritable: true },
    { pubkey: mintMapping0Key, isSigner: false, isWritable: false },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: poolState1Key, isSigner: false, isWritable: true },
    { pubkey: nullifierSet1Key, isSigner: false, isWritable: true },
    { pubkey: commitmentTree1Key, isSigner: false, isWritable: true },
    { pubkey: noteLedger1Key, isSigner: false, isWritable: true },
    { pubkey: mintMapping1Key, isSigner: false, isWritable: false }
  );
  
  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: instructionKeys,
      data: poolCoder.instruction.encode('execute_batch_transfer', {
        operation_id: operationIdHexToArray(params.operationId)
      })
    })
  );
  
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
  const { operationId } = await prepareBatchTransfer(params);
  // eslint-disable-next-line no-unused-vars
  const { batchProof: _batchProof, ...executeParams } = params;
  return executeBatchTransfer({ ...executeParams, operationId });
}

export type PrepareBatchTransferFromResult = PrepareResult;

export async function prepareBatchTransferFrom(
  params: PrepareBatchTransferFromParams
): Promise<PrepareBatchTransferFromResult> {
  assertWallet(params.wallet);
  
  if (params.transfers.length < 2 || params.transfers.length > 10) {
    throw new Error('Batch transfer requires 2-10 transfers');
  }
  
  // For now, support exactly 2 transfers (matches circuit)
  if (params.transfers.length !== 2) {
    throw new Error('Currently only 2 transfers are supported (circuit limitation)');
  }
  
  if (params.allowances.length !== 2) {
    throw new Error('Batch transfer from requires exactly 2 allowances (one per transfer)');
  }
  
  // Validate all transfers have matching commitment counts
  for (const transfer of params.transfers) {
    if (transfer.outputCommitments.length !== transfer.outputAmountCommitments.length) {
      throw new Error(`Transfer ${transfer.originMint}: Output commitment set mismatch`);
    }
  }
  
  // Extract roots from batch public inputs (same as prepareBatchTransfer)
  if (params.batchPublicInputs.length !== 16) {
    throw new Error(`Invalid batch public inputs length: expected 16, got ${params.batchPublicInputs.length}`);
  }
  
  const oldRoot0Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[0]!));
  const newRoot0Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[1]!));
  const oldRoot1Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[8]!));
  const newRoot1Bytes = canonicalHexToBytesLE(canonicalizeHex(params.batchPublicInputs[9]!));
  
  // OPTIMIZATION: Only include 1 output in TransferArgs when second output is zero (saves 64 bytes per transfer)
  const isSecondOutputZero0 = params.transfers[0]!.outputAmountCommitments.length >= 2 && 
    Buffer.from(canonicalHexToBytesLE(canonicalizeHex(params.transfers[0]!.outputAmountCommitments[1]!))).every(b => b === 0);
  const isSecondOutputZero1 = params.transfers[1]!.outputAmountCommitments.length >= 2 && 
    Buffer.from(canonicalHexToBytesLE(canonicalizeHex(params.transfers[1]!.outputAmountCommitments[1]!))).every(b => b === 0);
  
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
  
  // Create TransferArgs for each transfer (same as prepareBatchTransfer)
  const transferArgs0 = {
    old_root: Array.from(oldRoot0Bytes),
    new_root: Array.from(newRoot0Bytes),
    nullifiers: encodeFieldVector(params.transfers[0]!.nullifiers, 'nullifiers'),
    output_commitments: encodeFieldVector(outputCommitments0, 'output_commitments'),
    output_amount_commitments: encodeFieldVector(outputAmountCommitments0, 'output_amount_commitments'),
    proof: [], // Empty Vec<u8> - batch proof used instead
    public_inputs: [] // Empty Vec<u8> - batch public inputs used instead
  };
  
  const transferArgs1 = {
    old_root: Array.from(oldRoot1Bytes),
    new_root: Array.from(newRoot1Bytes),
    nullifiers: encodeFieldVector(params.transfers[1]!.nullifiers, 'nullifiers'),
    output_commitments: encodeFieldVector(outputCommitments1, 'output_commitments'),
    output_amount_commitments: encodeFieldVector(outputAmountCommitments1, 'output_amount_commitments'),
    proof: [], // Empty Vec<u8> - batch proof used instead
    public_inputs: [] // Empty Vec<u8> - batch public inputs used instead
  };
  
  // Create BatchTransferArgs (same as prepareBatchTransfer)
  const batchProofBytes = Buffer.from(params.batchProof.proof, 'base64');
  const batchPublicInputsBytes = Buffer.concat(
    params.batchPublicInputs.map(input => canonicalHexToBytesLE(canonicalizeHex(input)))
  );
  
  const batchTransferArgs = {
    transfers: [transferArgs0, transferArgs1],
    proof: Array.from(batchProofBytes),
    public_inputs: Array.from(batchPublicInputsBytes)
  };
  
  // Create TransferFromAllowanceInfo for each transfer
  const allowances = params.allowances.map(allowance => ({
    allowance_amount: new BN(allowance.allowanceAmount.toString()),
    spend_amount: new BN(allowance.spendAmount.toString())
  }));
  
  // Create BatchTransferFromArgs
  const batchTransferFromArgs = {
    batch_transfer: batchTransferArgs,
    allowances
  };

  return sendPrepareInstruction(
    params.connection,
    params.wallet,
    poolCoder.instruction.encode('prepare_batch_transfer_from', { batch_args: batchTransferFromArgs })
  );
}

export async function executeBatchTransferFrom(
  params: ExecuteBatchTransferFromParams
): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const spender = wallet.publicKey;
  if (!spender) {
    throw new Error('Wallet public key missing');
  }

  if (params.transfers.length !== 2) {
    throw new Error('Currently only 2 transfers are supported');
  }
  
  if (params.allowances.length !== 2) {
    throw new Error('Batch transfer from requires exactly 2 allowances');
  }
  
  // Derive accounts for first pool
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
  
  // Derive allowance 0
  const allowanceOwner0 = new PublicKey(params.allowances[0]!.allowanceOwner);
  const allowance0Key = deriveAllowanceAccount(poolState0Key, allowanceOwner0, spender);
  
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
  
  // Derive allowance 1
  const allowanceOwner1 = new PublicKey(params.allowances[1]!.allowanceOwner);
  const allowance1Key = deriveAllowanceAccount(poolState1Key, allowanceOwner1, spender);
  
  const verifyingKey = deriveVerifyingKey();
  const proofVault = deriveProofVault(wallet.publicKey!);
  
  const instructions: TransactionInstruction[] = [];
  
  // Add compute budget
  const computeLimitEnv =
    process.env.BATCH_TRANSFER_FROM_COMPUTE_UNIT_LIMIT ??
    process.env.BATCH_TRANSFER_COMPUTE_UNIT_LIMIT ??
    process.env.TRANSFER_FROM_COMPUTE_UNIT_LIMIT ??
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
  
  // Build execute_batch_transfer_from instruction
  // Account order matches ExecuteBatchTransferFrom struct: spender, proof_vault, system_program, rent
  // All other accounts go in remaining_accounts
  const instructionKeys = [
    { pubkey: spender, isSigner: true, isWritable: true },
    { pubkey: proofVault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add remaining accounts:
  // Pool 0: pool_state_0, nullifier_set_0, commitment_tree_0, note_ledger_0, mint_mapping_0, allowance_0, allowance_owner_0
  // Shared: verifier_program, verifying_key
  // Pool 1: pool_state_1, nullifier_set_1, commitment_tree_1, note_ledger_1, mint_mapping_1, allowance_1, allowance_owner_1
  instructionKeys.push(
    { pubkey: poolState0Key, isSigner: false, isWritable: true },
    { pubkey: nullifierSet0Key, isSigner: false, isWritable: true },
    { pubkey: commitmentTree0Key, isSigner: false, isWritable: true },
    { pubkey: noteLedger0Key, isSigner: false, isWritable: true },
    { pubkey: mintMapping0Key, isSigner: false, isWritable: false },
    { pubkey: allowance0Key, isSigner: false, isWritable: true },
    { pubkey: allowanceOwner0, isSigner: false, isWritable: false },
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: poolState1Key, isSigner: false, isWritable: true },
    { pubkey: nullifierSet1Key, isSigner: false, isWritable: true },
    { pubkey: commitmentTree1Key, isSigner: false, isWritable: true },
    { pubkey: noteLedger1Key, isSigner: false, isWritable: true },
    { pubkey: mintMapping1Key, isSigner: false, isWritable: false },
    { pubkey: allowance1Key, isSigner: false, isWritable: true },
    { pubkey: allowanceOwner1, isSigner: false, isWritable: false }
  );
  
  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: instructionKeys,
      data: poolCoder.instruction.encode('execute_batch_transfer_from', {
        operation_id: operationIdHexToArray(params.operationId)
      })
    })
  );
  
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

export async function batchTransferFrom(params: BatchTransferFromParams): Promise<string> {
  const { operationId } = await prepareBatchTransferFrom(params);
  // eslint-disable-next-line no-unused-vars
  const { batchProof: _batchProof, ...executeParams } = params;
  return executeBatchTransferFrom({ ...executeParams, operationId });
}

export interface CleanupExpiredOperationsParams {
  connection: Connection;
  wallet: WalletContextState;
  keypair?: Keypair;
}

export async function cleanupExpiredOperations(
  params: CleanupExpiredOperationsParams
): Promise<string> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const payer = wallet.publicKey;
  if (!payer) {
    throw new Error('Wallet public key missing');
  }
  
  const proofVault = deriveProofVault(wallet.publicKey!);
  
  const instructions: TransactionInstruction[] = [];
  
  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: proofVault, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true }
      ],
      data: poolCoder.instruction.encode('cleanup_expired_operations', {})
    })
  );
  
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
 * Get token metadata from TokenMetadata account
 */
export async function getTokenMetadata(
  connection: Connection,
  mint: PublicKey
): Promise<{ name: string; symbol: string; uri: string } | null> {
  try {
    const metadataKey = deriveTokenMetadata(mint);
    const metadataInfo = await connection.getAccountInfo(metadataKey, 'confirmed');
    if (!metadataInfo) {
      return null;
    }
    const metadata = factoryCoder.accounts.decode('TokenMetadata', metadataInfo.data) as {
      name: string;
      symbol: string;
      uri: string;
    };
    return {
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri
    };
  } catch (error) {
    console.warn('[getTokenMetadata] Failed to fetch metadata:', error);
    return null;
  }
}

/**
 * Mint a native zToken (creates a new token with metadata)
 */
export async function mintNativeZToken(params: MintNativeZTokenParams): Promise<MintNativeZTokenResult> {
  assertWallet(params.wallet);
  const wallet = params.wallet;
  const connection = params.connection;
  const payer = wallet.publicKey;
  if (!payer) {
    throw new Error('Wallet public key missing');
  }

  // Create mint keypair
  const mintKeypair = Keypair.generate();
  const originMint = mintKeypair.publicKey;

  // Derive accounts
  const factoryState = deriveFactoryState();
  const metadataKey = deriveTokenMetadata(originMint);
  const mintMappingKey = deriveMintMapping(originMint);
  const poolState = derivePoolState(originMint);
  const vaultState = deriveVaultState(originMint);
  const commitmentTree = deriveCommitmentTree(originMint);
  const nullifierSet = deriveNullifierSet(originMint);
  const noteLedger = deriveNoteLedger(originMint);
  const hookConfig = deriveHookConfig(originMint);
  const hookWhitelist = deriveHookWhitelist(originMint);
  const verifyingKey = deriveVerifyingKey();

  // Get user token account
  const userTokenAccount = await getAssociatedTokenAddress(
    originMint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Build instruction
  const instructionData = factoryCoder.instruction.encode('mint_native_ztoken', {
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    decimals: params.decimals,
    initialSupply: typeof params.initialSupply === 'bigint' 
      ? new BN(params.initialSupply.toString())
      : new BN(params.initialSupply.toString()),
    featureFlags: params.featureFlags ? params.featureFlags : null,
    feeBpsOverride: params.feeBpsOverride ? params.feeBpsOverride : null
  });

  const instruction = new TransactionInstruction({
    programId: FACTORY_PROGRAM_ID,
    keys: [
      { pubkey: factoryState, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: originMint, isSigner: true, isWritable: true },
      { pubkey: metadataKey, isSigner: false, isWritable: true },
      { pubkey: mintMappingKey, isSigner: false, isWritable: true },
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
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: instructionData
  });

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(instruction);
  tx.feePayer = payer;
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.sign(mintKeypair); // Sign with mint keypair

  const signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
  
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
    metadataAccount: metadataKey.toBase58(),
    mintMapping: mintMappingKey.toBase58(),
    decimals: params.decimals,
    symbol: params.symbol,
    uri: params.uri
  };
}

// DEX functions - TODO: Implement these (separate from Proof Account Abstraction)
export async function createDexPool(params: any): Promise<string> {
  throw new Error('createDexPool not yet implemented');
}

export async function addDexLiquidity(params: any): Promise<string> {
  throw new Error('addDexLiquidity not yet implemented');
}

export async function removeDexLiquidity(params: any): Promise<string> {
  throw new Error('removeDexLiquidity not yet implemented');
}

export async function getDexPoolState(connection: Connection, tokenA: PublicKey, tokenB: PublicKey): Promise<any> {
  throw new Error('getDexPoolState not yet implemented');
}

export async function swapDex(params: any): Promise<string> {
  throw new Error('swapDex not yet implemented');
}
