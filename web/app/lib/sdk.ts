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
  proofToShieldArgs,
  proofToTransferArgs
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
    
    // Check current wSOL balance and SOL balance
    const currentWSolBalance = await getWrappedSolBalance(connection, wallet.publicKey);
    const currentSolBalance = await connection.getBalance(wallet.publicKey);
    const amountInLamports = params.amount;
    
    console.log('[wrap] Balance check - SOL:', currentSolBalance, 'lamports, wSOL:', currentWSolBalance.toString(), 'lamports, Required:', amountInLamports.toString());
    
    // Check if we need to wrap more SOL
    const balanceCheck = await checkWrappedSolBalance(connection, wallet.publicKey, amountInLamports);
    
    if (!balanceCheck.hasEnough) {
      console.log('[wrap] Need to wrap', balanceCheck.needsWrap.toString(), 'lamports of SOL to wSOL');
      // We'll add wrap instructions before the shield instruction
    } else {
      console.log('[wrap] Sufficient wSOL balance available, no wrapping needed');
    }
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

  // SOL WRAPPING: Add wrap instructions BEFORE shield if shielding SOL
  if (isShieldingSOL && wsolTokenAccount) {
    console.log('[wrap] 🔄 Adding SOL wrap instructions to transaction');
    const balanceCheck = await checkWrappedSolBalance(connection, wallet.publicKey, amount);
    
    if (!balanceCheck.hasEnough) {
      const wrapAmount = balanceCheck.needsWrap;
      const existingWSol = balanceCheck.currentBalance;
      console.log('[wrap] Existing wSOL balance:', existingWSol.toString(), 'lamports');
      console.log('[wrap] Required:', amount.toString(), 'lamports');
      console.log('[wrap] 💰 Wrapping', wrapAmount.toString(), 'additional lamports of SOL to wSOL (using existing', existingWSol.toString(), 'first)');
      const wrapInstructions = await createWrapSolInstructions(
        wsolTokenAccount,
        wrapAmount,
        wallet.publicKey,
        connection
      );
      instructions.push(...wrapInstructions);
      console.log('[wrap] ✅ Added', wrapInstructions.length, 'wrap instructions');
    } else {
      console.log('[wrap] ✅ Sufficient wSOL balance available - using existing wSOL, no wrapping needed');
      console.log('[wrap] Using', balanceCheck.currentBalance.toString(), 'lamports from existing wSOL balance');
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
            // Check if this is a PendingShieldInFlight error - if so, throw it to trigger retry logic
            const { isPendingShieldError } = require('./errorHandler');
            if (isPendingShieldError(signError)) {
              throw signError; // Re-throw to trigger retry logic in catch block below
            }
            console.warn('[wrap] Failed to sign VersionedTransaction with wallet adapter:', signError);
            // Fall through to try keypair or regular transaction
            signedTransaction = null;
          }
        }
        
        // Fallback: try manual signing with keypair (for test scenarios)
        if (!signedTransaction && !shieldSignature) {
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
              signedTransaction = null;
            }
          }
          
          // Can't sign VersionedTransaction - fall back to regular Transaction
          // BUT: If transaction is too large, we need to wait for pending shield or retry with VersionedTransaction
          if (!shieldSignature) {
            console.warn('[wrap] Cannot sign VersionedTransaction, falling back to regular Transaction (may exceed size limits)');
            const regularTx = new Transaction().add(...shieldInstructionSet);
            const txSize = regularTx.serialize().length;
            if (txSize > 1232) {
              // Transaction is too large - check if this is due to pending shield blocking VersionedTransaction
              // If so, throw an error that will be caught and trigger retry logic
              console.warn(`[wrap] Regular Transaction too large (${txSize} bytes > 1232). VersionedTransaction likely failed due to pending shield. Will retry.`);
              // Throw error to trigger retry - will be caught as PendingShieldInFlight if that's the cause
              throw new Error('Transaction too large for regular Transaction. VersionedTransaction failed, likely due to pending shield.');
            }
            regularTx.feePayer = wallet.publicKey;
            regularTx.recentBlockhash = latestBlockhash.blockhash;
            try {
              shieldSignature = await wallet.sendTransaction(regularTx, connection, {
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
        }
      } else {
        // Fall back to regular Transaction if ALT not available
        const regularTx = new Transaction().add(...shieldInstructionSet);
        const txSize = regularTx.serialize().length;
        if (txSize > 1232) {
          // Transaction too large - cannot proceed without ALT
          throw new Error(`Transaction too large (${txSize} bytes > 1232). Address Lookup Table required but not available.`);
        }
        regularTx.feePayer = wallet.publicKey;
        regularTx.recentBlockhash = latestBlockhash.blockhash;
        try {
          shieldSignature = await wallet.sendTransaction(regularTx, connection, {
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
      // Check if wSOL account has balance before unwrapping
      const wsolBalance = await getWrappedSolBalance(connection, destinationKey);
      console.log('[unwrap] wSOL balance after unshield:', wsolBalance.toString(), 'lamports');
      
      if (wsolBalance > 0n) {
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
        
        console.log('[unwrap] 💰 Sending unwrap transaction to convert wSOL to native SOL');
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
      } else {
        console.warn('[unwrap] ⚠️ wSOL balance is 0, skipping unwrap');
      }
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
  tokenAIsZtoken: boolean;
  tokenBIsZtoken: boolean;
  publicReserveA: bigint;
  publicReserveB: bigint;
  privateReserveACommitment: Uint8Array;
  privateReserveBCommitment: Uint8Array;
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
    tokenAIsZtoken: decoded.token_a_is_ztoken ?? decoded.tokenAIsZtoken ?? false,
    tokenBIsZtoken: decoded.token_b_is_ztoken ?? decoded.tokenBIsZtoken ?? false,
    publicReserveA: BigInt(decoded.public_reserve_a?.toString() || decoded.publicReserveA?.toString() || '0'),
    publicReserveB: BigInt(decoded.public_reserve_b?.toString() || decoded.publicReserveB?.toString() || '0'),
    privateReserveACommitment: Buffer.from(decoded.private_reserve_a_commitment || decoded.privateReserveACommitment || Array(32).fill(0)),
    privateReserveBCommitment: Buffer.from(decoded.private_reserve_b_commitment || decoded.privateReserveBCommitment || Array(32).fill(0)),
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
  tokenA: string | PublicKey;
  tokenB: string | PublicKey;
  initialAmountA: bigint;
  initialAmountB: bigint;
  tokenAIsZtoken: boolean;
  tokenBIsZtoken: boolean;
  // Optional: Proof client for zToken operations
  proofClient?: ProofClient;
  // Optional: User notes for zToken transfers (if adding zToken liquidity)
  // Note: For create_pool, zToken initial liquidity requires shield proofs
  zTokenNotesA?: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
  zTokenNotesB?: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
}

interface AddLiquidityParams {
  connection: Connection;
  wallet: WalletContextState;
  tokenA: string | PublicKey;
  tokenB: string | PublicKey;
  amountA: bigint;
  amountB: bigint;
  minLpTokens: bigint;
  // Optional: Proof client for zToken operations
  proofClient?: ProofClient;
  // Optional: User notes for zToken transfers (required if adding zToken liquidity)
  zTokenNotesA?: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
  zTokenNotesB?: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
}

interface RemoveLiquidityParams {
  connection: Connection;
  wallet: WalletContextState;
  tokenA: string | PublicKey;
  tokenB: string | PublicKey;
  lpAmount: bigint;
  minAmountA: bigint;
  minAmountB: bigint;
}

interface SwapParams {
  connection: Connection;
  wallet: WalletContextState;
  tokenA: string | PublicKey;
  tokenB: string | PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  aToB: boolean; // true = swap tokenA -> tokenB, false = swap tokenB -> tokenA
  // Optional: Proof client for zToken operations
  proofClient?: ProofClient;
  // Optional: User notes for zToken input (required if input is zToken)
  zTokenInputNotes?: Array<{ noteId: string; spendingKey: string; amount: bigint }>;
}

/**
 * Create a new DEX pool.
 * 
 * @param params - Create pool parameters
 * @returns Transaction signature
 */
export async function createDexPool(params: CreateDexPoolParams): Promise<string> {
  assertWallet(params.wallet);
  const { connection, wallet } = params;
  const payer = wallet.publicKey!;
  
  const originalTokenA = typeof params.tokenA === 'string' ? new PublicKey(params.tokenA) : params.tokenA;
  const originalTokenB = typeof params.tokenB === 'string' ? new PublicKey(params.tokenB) : params.tokenB;
  
  // SOL HANDLING: Detect if SOL is selected and convert to wSOL mint
  const originalTokenAIsSOL = isNativeSol(originalTokenA);
  const originalTokenBIsSOL = isNativeSol(originalTokenB);
  
  // Convert SOL to wSOL mint for pool operations
  let tokenA = originalTokenAIsSOL ? NATIVE_SOL_MINT : originalTokenA;
  let tokenB = originalTokenBIsSOL ? NATIVE_SOL_MINT : originalTokenB;
  
  if (originalTokenAIsSOL) {
    console.log('[createDexPool] ⚡ Token A is SOL - using wSOL mint for pool');
  }
  if (originalTokenBIsSOL) {
    console.log('[createDexPool] ⚡ Token B is SOL - using wSOL mint for pool');
  }
  
  // Ensure canonical order (token_a < token_b)
  const canonicalOrder = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint, tokenAIsZtoken, tokenBIsZtoken, actualTokenAIsSOL, actualTokenBIsSOL] = canonicalOrder
      ? [tokenA, tokenB, params.tokenAIsZtoken, params.tokenBIsZtoken, originalTokenAIsSOL, originalTokenBIsSOL]
      : [tokenB, tokenA, params.tokenBIsZtoken, params.tokenAIsZtoken, originalTokenBIsSOL, originalTokenAIsSOL];
  
  const initialAmountA = canonicalOrder ? params.initialAmountA : params.initialAmountB;
  const initialAmountB = canonicalOrder ? params.initialAmountB : params.initialAmountA;
  
  // Get wSOL accounts if needed (after canonical ordering)
  let wsolTokenAccountA: PublicKey | null = null;
  let wsolTokenAccountB: PublicKey | null = null;
  
  if (actualTokenAIsSOL) {
    wsolTokenAccountA = await getWrappedSolAccount(payer);
    console.log('[createDexPool] wSOL token account A:', wsolTokenAccountA.toBase58());
  }
  
  if (actualTokenBIsSOL) {
    wsolTokenAccountB = await getWrappedSolAccount(payer);
    console.log('[createDexPool] wSOL token account B:', wsolTokenAccountB.toBase58());
  }
  
  // Derive PDAs
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  
  // Check if pool already exists
  const existingPool = await connection.getAccountInfo(poolState, 'confirmed');
  if (existingPool) {
    throw new Error('Pool already exists');
  }
  
  // Get or create LP token mint (we'll need to generate a keypair for it)
  const lpTokenMint = Keypair.generate();
  
  // Get or create token accounts
  const userLpTokenAccount = await getAssociatedTokenAddress(
    lpTokenMint.publicKey,
    payer,
    false,
    TOKEN_PROGRAM_ID, // Use TOKEN_PROGRAM_ID to match the LP mint
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // For zTokens, we still need valid accounts (even if not used) to satisfy Anchor's mut constraint
  // We'll create valid token accounts but skip transfers in the instruction
  // If SOL was detected, use wSOL token accounts directly
  const userTokenAAccount = (actualTokenAIsSOL && wsolTokenAccountA) 
    ? wsolTokenAccountA // Use wSOL account if SOL
    : (tokenAIsZtoken 
      ? await getAssociatedTokenAddress(
          tokenAMint,
          payer,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      : await getAssociatedTokenAddress(
          tokenAMint,
          payer,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ));
  
  const poolTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint, // Will be wSOL mint if SOL was detected
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenBAccount = (actualTokenBIsSOL && wsolTokenAccountB)
    ? wsolTokenAccountB // Use wSOL account if SOL
    : (tokenBIsZtoken
      ? await getAssociatedTokenAddress(
          tokenBMint,
          payer,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      : await getAssociatedTokenAddress(
          tokenBMint,
          payer,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ));
  
  const poolTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint, // Will be wSOL mint if SOL was detected
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Build instruction
  const instructions: TransactionInstruction[] = [];
  
  // SOL WRAPPING: Add wrap instructions BEFORE pool creation if SOL is selected
  if (actualTokenAIsSOL && wsolTokenAccountA) {
    console.log('[createDexPool] 🔄 Wrapping SOL to wSOL for token A before pool creation');
    const balanceCheck = await checkWrappedSolBalance(connection, payer, initialAmountA);
    if (!balanceCheck.hasEnough) {
      const wrapAmount = balanceCheck.needsWrap;
      console.log('[createDexPool] 💰 Wrapping', wrapAmount.toString(), 'lamports of SOL to wSOL for token A');
      const wrapInstructions = await createWrapSolInstructions(
        wsolTokenAccountA,
        wrapAmount,
        payer,
        connection
      );
      instructions.push(...wrapInstructions);
    } else {
      console.log('[createDexPool] ✅ Sufficient wSOL balance for token A, no wrapping needed');
    }
  }
  
  if (actualTokenBIsSOL && wsolTokenAccountB) {
    console.log('[createDexPool] 🔄 Wrapping SOL to wSOL for token B before pool creation');
    const balanceCheck = await checkWrappedSolBalance(connection, payer, initialAmountB);
    if (!balanceCheck.hasEnough) {
      const wrapAmount = balanceCheck.needsWrap;
      console.log('[createDexPool] 💰 Wrapping', wrapAmount.toString(), 'lamports of SOL to wSOL for token B');
      const wrapInstructions = await createWrapSolInstructions(
        wsolTokenAccountB,
        wrapAmount,
        payer,
        connection
      );
      instructions.push(...wrapInstructions);
    } else {
      console.log('[createDexPool] ✅ Sufficient wSOL balance for token B, no wrapping needed');
    }
  }
  
  // Create LP token mint account if needed (for public tokens, we'll use Token-2022)
  // Note: This will be handled in the instruction via CPI, but we need to ensure accounts exist
  
  // Check if user token accounts exist, create if needed
  // Note: Pool token ATAs will be created in a follow-up transaction after poolState exists
  // If SOL was detected, wSOL account is already handled in wrap instructions above
  if (!tokenAIsZtoken && !actualTokenAIsSOL) {
    const userTokenAAccountInfo = await connection.getAccountInfo(userTokenAAccount, 'confirmed');
    if (!userTokenAAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer,
          userTokenAAccount,
          payer,
          tokenAMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  
  if (!tokenBIsZtoken && !actualTokenBIsSOL) {
    const userTokenBAccountInfo = await connection.getAccountInfo(userTokenBAccount, 'confirmed');
    if (!userTokenBAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer,
          userTokenBAccount,
          payer,
          tokenBMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  
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
  
  // Encode create_pool instruction
  // Convert BigInt to BN for encoding
  const amountABN = new BN(initialAmountA.toString());
  const amountBBN = new BN(initialAmountB.toString());
  
  // Debug: Log amounts to verify
  if (process.env.DEBUG_DEX === 'true') {
    console.log('[createDexPool] Encoding amounts:', {
      initialAmountA: initialAmountA.toString(),
      initialAmountB: initialAmountB.toString(),
      amountABN: amountABN.toString(),
      amountBBN: amountBBN.toString()
    });
  }
  
  const createPoolData = dexCoder.instruction.encode('create_pool', {
    initial_amount_a: amountABN,  // Use snake_case to match IDL
    initial_amount_b: amountBBN,  // Use snake_case to match IDL
    token_a_is_ztoken: tokenAIsZtoken,  // Use snake_case to match IDL
    token_b_is_ztoken: tokenBIsZtoken,   // Use snake_case to match IDL
    shield_args_a: null,  // Optional: null for public tokens, ShieldArgs for zTokens
    shield_args_b: null   // Optional: null for public tokens, ShieldArgs for zTokens
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
  
  // Build instruction keys
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: lpTokenMint.publicKey, isSigner: true, isWritable: true },
    { pubkey: userLpTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Use TOKEN_PROGRAM_ID for regular token transfers
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // For creating pool token ATAs
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
  ];
  
  // Add zToken pool accounts to remaining_accounts if needed
  // For shield operations, we need 14 accounts per zToken
  // TODO: Generate proofs and add ShieldArgs to instruction data when instruction signature is updated
  if (tokenAIsZtoken || tokenBIsZtoken) {
    console.info('[createDexPool] Adding zToken pool accounts to remaining_accounts');
    
    if (tokenAIsZtoken) {
      const zTokenAccountsA = getZTokenPoolAccounts(tokenAMint, true); // forShield = true
      const vaultStateA = deriveVaultState(tokenAMint);
      const poolStateA = derivePoolState(tokenAMint);
      
      // Get vault token account and depositor token account
      // For shield, we need: vault_token_account, depositor_token_account (user's token account)
      const vaultTokenAccountA = await getAssociatedTokenAddress(
        tokenAMint,
        vaultStateA,
        true, // allowOwnerOffCurve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      // Add zToken accounts for token A (14 accounts for shield)
      instructionKeys.push(...zTokenAccountsA.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true // Most accounts are writable for shield operations
      })));
      
      // Add vault_token_account and depositor_token_account (user's public token account)
      instructionKeys.push(
        { pubkey: vaultTokenAccountA, isSigner: false, isWritable: true },
        { pubkey: userTokenAAccount, isSigner: false, isWritable: true } // depositor_token_account
      );
      
      console.info(`[createDexPool] Added ${zTokenAccountsA.length + 2} accounts for zToken A shield operation`);
    }
    
    if (tokenBIsZtoken) {
      const zTokenAccountsB = getZTokenPoolAccounts(tokenBMint, true); // forShield = true
      const vaultStateB = deriveVaultState(tokenBMint);
      
      const vaultTokenAccountB = await getAssociatedTokenAddress(
        tokenBMint,
        vaultStateB,
        true, // allowOwnerOffCurve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      // Add zToken accounts for token B (14 accounts for shield)
      instructionKeys.push(...zTokenAccountsB.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true
      })));
      
      // Add vault_token_account and depositor_token_account
      instructionKeys.push(
        { pubkey: vaultTokenAccountB, isSigner: false, isWritable: true },
        { pubkey: userTokenBAccount, isSigner: false, isWritable: true } // depositor_token_account
      );
      
      console.info(`[createDexPool] Added ${zTokenAccountsB.length + 2} accounts for zToken B shield operation`);
    }
    
    // TODO: Generate shield proofs and add ShieldArgs to instruction data
    // This requires updating the instruction signature to accept ShieldArgs parameters
    console.info('[createDexPool] NOTE: Shield proof generation pending - ShieldArgs need to be added to instruction signature');
    
    // Add payer, system_program, rent to remaining_accounts
    // This ensures all AccountInfos have the same lifetime scope, avoiding Rust borrow checker conflicts
    // Note: payer and system_program are already in instructionKeys, but rent is needed for CPIs
    // Add them again to remaining_accounts for CPI calls (they'll be deduplicated by Solana runtime)
    instructionKeys.push(
      { pubkey: payer, isSigner: true, isWritable: true }, // payer (signer for CPI)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false } // rent
    );
    
    console.info('[createDexPool] Added payer, system_program, rent to remaining_accounts (unified lifetime scope)');
  }
  
  instructions.push(
    new TransactionInstruction({
      programId: DEX_PROGRAM_ID,
      keys: instructionKeys,
      data: createPoolData
    })
  );
  
  // Send transaction
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer;
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.partialSign(lpTokenMint); // Sign the LP mint creation
  
  console.log('[createDexPool] Transaction has', instructions.length, 'instructions');
  instructions.forEach((ix, idx) => {
    console.log(`[createDexPool] Instruction ${idx}: program=${ix.programId.toBase58()}, keys=${ix.keys.length}, data=${ix.data.length} bytes`);
    if (ix.keys.length > 0) {
      console.log(`[createDexPool]   First key: ${ix.keys[0].pubkey.toBase58()} (signer=${ix.keys[0].isSigner}, writable=${ix.keys[0].isWritable})`);
    }
  });
  
  const signature = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
  
  await waitForSignatureConfirmation(
    connection,
    signature,
    latestBlockhash.blockhash,
    latestBlockhash.lastValidBlockHeight
  );
  
  // Log success for SOL pool creation
  if (actualTokenAIsSOL || actualTokenBIsSOL) {
    console.log('[createDexPool] ✅ Successfully created pool with SOL');
    if (actualTokenAIsSOL) console.log('[createDexPool] Token A: SOL → wSOL');
    if (actualTokenBIsSOL) console.log('[createDexPool] Token B: SOL → wSOL');
    console.log('[createDexPool] Pool creation signature:', signature);
  }
  
  // Follow-up transaction 1: Create pool token ATAs (now poolState exists)
  const followUpInstructions1: TransactionInstruction[] = [];
  
  if (!tokenAIsZtoken) {
    const poolTokenAAccountInfo = await connection.getAccountInfo(poolTokenAAccount, 'confirmed');
    if (!poolTokenAAccountInfo) {
      followUpInstructions1.push(
        createAssociatedTokenAccountInstruction(
          payer,
          poolTokenAAccount,
          poolState,  // Now poolState PDA exists
          tokenAMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  
  if (!tokenBIsZtoken) {
    const poolTokenBAccountInfo = await connection.getAccountInfo(poolTokenBAccount, 'confirmed');
    if (!poolTokenBAccountInfo) {
      followUpInstructions1.push(
        createAssociatedTokenAccountInstruction(
          payer,
          poolTokenBAccount,
          poolState,  // Now poolState PDA exists
          tokenBMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  
  // Send first follow-up transaction to create pool token ATAs
  if (followUpInstructions1.length > 0) {
    const followUpBlockhash1 = await connection.getLatestBlockhash('confirmed');
    const followUpTx1 = new Transaction().add(...followUpInstructions1);
    followUpTx1.feePayer = payer;
    followUpTx1.recentBlockhash = followUpBlockhash1.blockhash;
    
    const followUpSignature1 = await wallet.sendTransaction(followUpTx1, connection, { skipPreflight: false });
    await waitForSignatureConfirmation(
      connection,
      followUpSignature1,
      followUpBlockhash1.blockhash,
      followUpBlockhash1.lastValidBlockHeight
    );
    console.info(`[createDexPool] Pool token ATAs created: ${followUpSignature1}`);
  }
  
  // Follow-up transaction 2: Add initial liquidity (transfer tokens to pool and mint initial LP tokens)
  // This will be handled by add_liquidity instruction, but for now we'll create a simple transfer + mint transaction
  // For simplicity, we'll use add_liquidity in a separate call, or create a helper function
  // For now, just return the pool creation signature - user can call add_liquidity separately
  
  // TODO: Add initial liquidity transfer + LP mint in follow-up transaction
  
  return signature;
}

/**
 * Add liquidity to a DEX pool.
 * 
 * @param params - Add liquidity parameters
 * @returns Transaction signature
 */
export async function addDexLiquidity(params: AddLiquidityParams): Promise<string> {
  assertWallet(params.wallet);
  const { connection, wallet } = params;
  const payer = wallet.publicKey!;
  
  const originalTokenA = typeof params.tokenA === 'string' ? new PublicKey(params.tokenA) : params.tokenA;
  const originalTokenB = typeof params.tokenB === 'string' ? new PublicKey(params.tokenB) : params.tokenB;
  
  // SOL HANDLING: Detect if SOL is selected and convert to wSOL mint
  const originalTokenAIsSOL = isNativeSol(originalTokenA);
  const originalTokenBIsSOL = isNativeSol(originalTokenB);
  
  // Convert SOL to wSOL mint for pool operations
  let tokenA = originalTokenAIsSOL ? NATIVE_SOL_MINT : originalTokenA;
  let tokenB = originalTokenBIsSOL ? NATIVE_SOL_MINT : originalTokenB;
  
  if (originalTokenAIsSOL) {
    console.log('[addDexLiquidity] ⚡ Token A is SOL - using wSOL mint');
  }
  if (originalTokenBIsSOL) {
    console.log('[addDexLiquidity] ⚡ Token B is SOL - using wSOL mint');
  }
  
  // Ensure canonical order
  const canonicalOrder = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint, actualTokenAIsSOL, actualTokenBIsSOL] = canonicalOrder
    ? [tokenA, tokenB, originalTokenAIsSOL, originalTokenBIsSOL]
    : [tokenB, tokenA, originalTokenBIsSOL, originalTokenAIsSOL];
  
  const amountA = canonicalOrder ? params.amountA : params.amountB;
  const amountB = canonicalOrder ? params.amountB : params.amountA;
  
  // Get wSOL accounts if needed (after canonical ordering)
  let wsolTokenAccountA: PublicKey | null = null;
  let wsolTokenAccountB: PublicKey | null = null;
  
  if (actualTokenAIsSOL) {
    wsolTokenAccountA = await getWrappedSolAccount(payer);
    console.log('[addDexLiquidity] wSOL token account A:', wsolTokenAccountA.toBase58());
  }
  
  if (actualTokenBIsSOL) {
    wsolTokenAccountB = await getWrappedSolAccount(payer);
    console.log('[addDexLiquidity] wSOL token account B:', wsolTokenAccountB.toBase58());
  }
  
  // Get pool state to check if it exists and get LP mint
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
  if (!poolStateData) {
    throw new Error('Pool does not exist. Create pool first.');
  }
  
  const lpTokenMint = poolStateData.lpTokenMint;
  
  // Get or create token accounts
  // First, verify LP mint exists and get the correct token program ID
  const lpMintInfo = await connection.getAccountInfo(lpTokenMint, 'confirmed');
  if (!lpMintInfo) {
    throw new Error(`LP token mint does not exist: ${lpTokenMint.toBase58()}. Pool may not have been created properly.`);
  }
  const lpMintProgramId = lpMintInfo.owner;
  if (!lpMintProgramId.equals(TOKEN_PROGRAM_ID) && !lpMintProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`LP token mint has invalid owner: ${lpMintProgramId.toBase58()}. Expected TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID.`);
  }
  const lpTokenProgramId = lpMintProgramId.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  
  // Use the correct token program ID to derive user LP token account
  let userLpTokenAccount = await getAssociatedTokenAddress(
    lpTokenMint,
    payer,
    false,
    lpTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // If SOL was detected, use wSOL token account directly, otherwise derive ATA
  const userTokenAAccount = (actualTokenAIsSOL && wsolTokenAccountA) 
    ? wsolTokenAccountA // Use wSOL account if SOL
    : await getAssociatedTokenAddress(
        tokenAMint,
        payer,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
  const poolTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint, // Will be wSOL mint if SOL was detected
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenBAccount = (actualTokenBIsSOL && wsolTokenAccountB)
    ? wsolTokenAccountB // Use wSOL account if SOL
    : await getAssociatedTokenAddress(
        tokenBMint,
        payer,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
  const poolTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint, // Will be wSOL mint if SOL was detected
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Build instruction
  const instructions: TransactionInstruction[] = [];
  
  // SOL WRAPPING: Add wrap instructions BEFORE add liquidity if SOL is selected
  // Use existing wSOL balance first, then wrap only what's needed
  if (actualTokenAIsSOL && wsolTokenAccountA) {
    console.log('[addDexLiquidity] 🔄 Checking wSOL balance for token A - will use existing wSOL first');
    const balanceCheck = await checkWrappedSolBalance(connection, payer, amountA);
    if (!balanceCheck.hasEnough) {
      const wrapAmount = balanceCheck.needsWrap;
      console.log('[addDexLiquidity] Existing wSOL A balance:', balanceCheck.currentBalance.toString(), 'lamports');
      console.log('[addDexLiquidity] 💰 Wrapping', wrapAmount.toString(), 'additional lamports of SOL to wSOL for token A');
      const wrapInstructions = await createWrapSolInstructions(
        wsolTokenAccountA,
        wrapAmount,
        payer,
        connection
      );
      instructions.push(...wrapInstructions);
    } else {
      console.log('[addDexLiquidity] ✅ Sufficient wSOL A balance - using existing wSOL');
    }
  }
  
  if (actualTokenBIsSOL && wsolTokenAccountB) {
    console.log('[addDexLiquidity] 🔄 Checking wSOL balance for token B - will use existing wSOL first');
    const balanceCheck = await checkWrappedSolBalance(connection, payer, amountB);
    if (!balanceCheck.hasEnough) {
      const wrapAmount = balanceCheck.needsWrap;
      console.log('[addDexLiquidity] Existing wSOL B balance:', balanceCheck.currentBalance.toString(), 'lamports');
      console.log('[addDexLiquidity] 💰 Wrapping', wrapAmount.toString(), 'additional lamports of SOL to wSOL for token B');
      const wrapInstructions = await createWrapSolInstructions(
        wsolTokenAccountB,
        wrapAmount,
        payer,
        connection
      );
      instructions.push(...wrapInstructions);
    } else {
      console.log('[addDexLiquidity] ✅ Sufficient wSOL B balance - using existing wSOL');
    }
  }
  
  // Ensure token accounts exist
  // Note: If SOL was detected, wSOL account is already handled in wrap instructions above
  // Note: User token accounts should already exist from test setup, but check anyway
  if (!actualTokenAIsSOL) {
    const userTokenAAccountInfo = await connection.getAccountInfo(userTokenAAccount, 'confirmed');
    if (!userTokenAAccountInfo) {
      console.log(`[addDexLiquidity] Creating user token A account for mint: ${tokenAMint.toBase58()}`);
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer,
          userTokenAAccount,
          payer,
          tokenAMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    } else {
      console.log(`[addDexLiquidity] User token A account exists: ${userTokenAAccount.toBase58()}`);
    }
  }
  
  // Pool token ATAs should already exist from pool creation follow-up transaction
  // Don't try to create them here - if they don't exist, there's a problem
  const poolTokenAAccountInfo = await connection.getAccountInfo(poolTokenAAccount, 'confirmed');
  if (!poolTokenAAccountInfo) {
    throw new Error(`Pool token A account does not exist. Ensure pool was created properly. Expected: ${poolTokenAAccount.toBase58()}`);
  }
  
  if (!actualTokenBIsSOL) {
    const userTokenBAccountInfo = await connection.getAccountInfo(userTokenBAccount, 'confirmed');
    if (!userTokenBAccountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payer,
        userTokenBAccount,
        payer,
        tokenBMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  
  // Pool token B ATA should already exist
  const poolTokenBAccountInfo = await connection.getAccountInfo(poolTokenBAccount, 'confirmed');
  if (!poolTokenBAccountInfo) {
    throw new Error(`Pool token B account does not exist. Ensure pool was created properly. Expected: ${poolTokenBAccount.toBase58()}`);
  }
  
  // Create user LP token account if it doesn't exist (required by program)
  const userLpAccountInfo = await connection.getAccountInfo(userLpTokenAccount, 'confirmed');
  if (!userLpAccountInfo || userLpAccountInfo.owner.equals(SystemProgram.programId)) {
    console.log(`[addDexLiquidity] User LP token account does not exist, creating...`);
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
  } else {
    console.log(`[addDexLiquidity] User LP token account exists: ${userLpTokenAccount.toBase58()}`);
  }
  
  console.log(`[addDexLiquidity] Total instructions before add_liquidity: ${instructions.length}`);
  
  // Encode add_liquidity instruction
  // Use snake_case to match IDL
  const addLiquidityData = dexCoder.instruction.encode('add_liquidity', {
    amount_a: new BN(amountA.toString()),
    amount_b: new BN(amountB.toString()),
    min_lp_tokens: new BN(params.minLpTokens.toString()),
    transfer_args_a: null,  // Optional: null for public tokens, TransferArgs for zTokens
    transfer_args_b: null   // Optional: null for public tokens, TransferArgs for zTokens
  });
  
  // Build instruction keys
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: lpTokenMint, isSigner: false, isWritable: true },
    { pubkey: userLpTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false } // rent (required by IDL)
  ];
  
  // Add zToken pool accounts to remaining_accounts if needed
  // For transfer operations, we need 7 accounts per zToken (not shield)
  // SOLUTION 1: Add payer, system_program, rent to remaining_accounts to avoid lifetime conflicts
  // This ensures all accounts have the same lifetime scope from remaining_accounts
  if (poolStateData.tokenAIsZtoken || poolStateData.tokenBIsZtoken) {
    console.info('[addDexLiquidity] Adding zToken pool accounts to remaining_accounts');
    
    if (poolStateData.tokenAIsZtoken) {
      const zTokenAccountsA = getZTokenPoolAccounts(tokenAMint, false); // forShield = false (transfer)
      
      // Add zToken accounts for token A (7 accounts for transfer)
      instructionKeys.push(...zTokenAccountsA.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true // Most accounts are writable for transfer operations
      })));
      
      console.info(`[addDexLiquidity] Added ${zTokenAccountsA.length} accounts for zToken A transfer operation (user → pool PDA)`);
      
      // TODO: Generate transfer proof for token A
      // This requires user notes (zTokenNotesA) and proof generation
      if (params.zTokenNotesA && params.proofClient) {
        console.info('[addDexLiquidity] NOTE: Transfer proof generation pending - TransferArgs need to be added to instruction signature');
        // const transferProof = await generateDexTransferProof(...);
        // const transferArgs = proofToTransferArgs(transferProof);
      } else if (poolStateData.tokenAIsZtoken) {
        console.warn('[addDexLiquidity] zToken A requires notes and proofClient for transfer proof generation');
      }
    }
    
    if (poolStateData.tokenBIsZtoken) {
      const zTokenAccountsB = getZTokenPoolAccounts(tokenBMint, false); // forShield = false (transfer)
      
      // Add zToken accounts for token B (7 accounts for transfer)
      instructionKeys.push(...zTokenAccountsB.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true
      })));
      
      console.info(`[addDexLiquidity] Added ${zTokenAccountsB.length} accounts for zToken B transfer operation (user → pool PDA)`);
      
      // TODO: Generate transfer proof for token B
      if (params.zTokenNotesB && params.proofClient) {
        console.info('[addDexLiquidity] NOTE: Transfer proof generation pending - TransferArgs need to be added to instruction signature');
        // const transferProof = await generateDexTransferProof(...);
        // const transferArgs = proofToTransferArgs(transferProof);
      } else if (poolStateData.tokenBIsZtoken) {
        console.warn('[addDexLiquidity] zToken B requires notes and proofClient for transfer proof generation');
      }
    }
    
    // SOLUTION 1: Add payer, system_program, rent to remaining_accounts
    // This ensures all AccountInfos have the same lifetime scope, avoiding Rust borrow checker conflicts
    // These accounts are shared between token A and B CPIs if both are zTokens
    instructionKeys.push(
      { pubkey: payer, isSigner: true, isWritable: true }, // payer (signer for CPI)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false } // rent
    );
    
    console.info('[addDexLiquidity] Added payer, system_program, rent to remaining_accounts (Solution 1: unified lifetime scope)');
  }
  
  instructions.push(
    new TransactionInstruction({
      programId: DEX_PROGRAM_ID,
      keys: instructionKeys,
      data: addLiquidityData
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
 * Remove liquidity from a DEX pool.
 * 
 * @param params - Remove liquidity parameters
 * @returns Transaction signature
 */
export async function removeDexLiquidity(params: RemoveLiquidityParams): Promise<string> {
  assertWallet(params.wallet);
  const { connection, wallet } = params;
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
  
  // Get pool state
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
  if (!poolStateData) {
    throw new Error('Pool does not exist.');
  }
  
  const lpTokenMint = poolStateData.lpTokenMint;
  
  // Get the LP mint's program ID to use the correct token program
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
  
  const poolTokenAAccount = await getAssociatedTokenAddress(
    tokenAMint,
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
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
  
  const poolTokenBAccount = await getAssociatedTokenAddress(
    tokenBMint,
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Ensure user token accounts exist (for receiving output)
  // If SOL was detected, use wSOL token account (will receive wSOL from pool)
  let wsolTokenAccountA: PublicKey | null = null;
  let wsolTokenAccountB: PublicKey | null = null;
  
  if (actualTokenAIsSOL) {
    wsolTokenAccountA = await getWrappedSolAccount(payer);
    console.log('[removeDexLiquidity] wSOL token account A:', wsolTokenAccountA.toBase58());
  }
  
  if (actualTokenBIsSOL) {
    wsolTokenAccountB = await getWrappedSolAccount(payer);
    console.log('[removeDexLiquidity] wSOL token account B:', wsolTokenAccountB.toBase58());
  }
  
  // If SOL was detected, use wSOL token account directly, otherwise derive ATA
  const userTokenAAccount = (actualTokenAIsSOL && wsolTokenAccountA)
    ? wsolTokenAccountA
    : await getAssociatedTokenAddress(
        tokenAMint,
        payer,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
  const userTokenBAccount = (actualTokenBIsSOL && wsolTokenAccountB)
    ? wsolTokenAccountB
    : await getAssociatedTokenAddress(
        tokenBMint,
        payer,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
  const instructions: TransactionInstruction[] = [];
  
  // If SOL was detected, wSOL account should already exist (created during pool creation/liquidity addition)
  // For non-SOL tokens, create ATA if needed
  if (!actualTokenAIsSOL) {
    const userTokenAAccountInfo = await connection.getAccountInfo(userTokenAAccount, 'confirmed');
    if (!userTokenAAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer,
          userTokenAAccount,
          payer,
          tokenAMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  
  if (!actualTokenBIsSOL) {
    const userTokenBAccountInfo = await connection.getAccountInfo(userTokenBAccount, 'confirmed');
    if (!userTokenBAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer,
          userTokenBAccount,
          payer,
          tokenBMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  
  // Encode remove_liquidity instruction
  // Use snake_case to match IDL
  const removeLiquidityData = dexCoder.instruction.encode('remove_liquidity', {
    lp_amount: new BN(params.lpAmount.toString()),
    min_amount_a: new BN(minAmountA.toString()),
    min_amount_b: new BN(minAmountB.toString()),
    transfer_args_a: null,  // Optional: null for public tokens, TransferArgs for zTokens
    transfer_args_b: null   // Optional: null for public tokens, TransferArgs for zTokens
  });
  
  // Build instruction keys
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: lpTokenMint, isSigner: false, isWritable: true },
    { pubkey: userLpTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenAAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenBAccount, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false } // rent (required by IDL)
  ];
  
  // Add zToken pool accounts to remaining_accounts if needed
  // For transfer operations (pool PDA → user), we need 7 accounts per zToken
  if (poolStateData.tokenAIsZtoken || poolStateData.tokenBIsZtoken) {
    console.info('[removeDexLiquidity] Adding zToken pool accounts to remaining_accounts');
    
    if (poolStateData.tokenAIsZtoken) {
      const zTokenAccountsA = getZTokenPoolAccounts(tokenAMint, false); // forShield = false (transfer)
      
      // Add zToken accounts for token A (7 accounts for transfer)
      instructionKeys.push(...zTokenAccountsA.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true
      })));
      
      console.info(`[removeDexLiquidity] Added ${zTokenAccountsA.length} accounts for zToken A transfer operation (pool PDA → user)`);
    }
    
    if (poolStateData.tokenBIsZtoken) {
      const zTokenAccountsB = getZTokenPoolAccounts(tokenBMint, false); // forShield = false (transfer)
      
      // Add zToken accounts for token B (7 accounts for transfer)
      instructionKeys.push(...zTokenAccountsB.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true
      })));
      
      console.info(`[removeDexLiquidity] Added ${zTokenAccountsB.length} accounts for zToken B transfer operation (pool PDA → user)`);
    }
    
    // Add payer, system_program, rent to remaining_accounts
    // This ensures all AccountInfos have the same lifetime scope, avoiding Rust borrow checker conflicts
    instructionKeys.push(
      { pubkey: payer, isSigner: true, isWritable: true }, // payer (signer for CPI)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false } // rent
    );
    
    console.info('[removeDexLiquidity] Added payer, system_program, rent to remaining_accounts (unified lifetime scope)');
  }
  
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
  
  // SOL UNWRAPPING: If removing SOL liquidity, unwrap wSOL to native SOL after removal
  if (actualTokenAIsSOL && wsolTokenAccountA) {
    console.log('[removeDexLiquidity] 🔄 Removing SOL liquidity complete, now unwrapping wSOL to native SOL for token A');
    
    try {
      // Check if wSOL account has balance before unwrapping
      const wsolBalance = await getWrappedSolBalance(connection, payer);
      console.log('[removeDexLiquidity] wSOL A balance after removal:', wsolBalance.toString(), 'lamports');
      
      if (wsolBalance > 0n) {
        // Create unwrap instruction
        const unwrapInstruction = createUnwrapSolInstruction(
          wsolTokenAccountA,
          payer // Owner who will receive native SOL
        );
        
        // Send unwrap transaction
        const unwrapBlockhash = await connection.getLatestBlockhash('confirmed');
        const unwrapTransaction = new Transaction().add(unwrapInstruction);
        unwrapTransaction.feePayer = payer;
        unwrapTransaction.recentBlockhash = unwrapBlockhash.blockhash;
        
        console.log('[removeDexLiquidity] 💰 Sending unwrap transaction to convert wSOL to native SOL for token A');
        const unwrapSignature = await wallet.sendTransaction(unwrapTransaction, connection, {
          skipPreflight: false
        });
        
        await waitForSignatureConfirmation(
          connection,
          unwrapSignature,
          unwrapBlockhash.blockhash,
          unwrapBlockhash.lastValidBlockHeight
        );
        
        console.log('[removeDexLiquidity] ✅ Successfully unwrapped wSOL to native SOL for token A');
        console.log('[removeDexLiquidity] Unwrap signature:', unwrapSignature);
      } else {
        console.log('[removeDexLiquidity] ⚠️ wSOL A balance is 0, skipping unwrap');
      }
    } catch (unwrapError: any) {
      console.error('[removeDexLiquidity] ❌ Failed to unwrap wSOL A to SOL:', unwrapError);
      console.error('[removeDexLiquidity] ⚠️ Liquidity removal succeeded but unwrap failed - user has wSOL instead of SOL');
      // Don't throw - liquidity removal succeeded, just unwrap failed
    }
  }
  
  if (actualTokenBIsSOL && wsolTokenAccountB) {
    console.log('[removeDexLiquidity] 🔄 Removing SOL liquidity complete, now unwrapping wSOL to native SOL for token B');
    
    try {
      // Check if wSOL account has balance before unwrapping
      const wsolBalance = await getWrappedSolBalance(connection, payer);
      console.log('[removeDexLiquidity] wSOL B balance after removal:', wsolBalance.toString(), 'lamports');
      
      if (wsolBalance > 0n) {
        // Create unwrap instruction
        const unwrapInstruction = createUnwrapSolInstruction(
          wsolTokenAccountB,
          payer // Owner who will receive native SOL
        );
        
        // Send unwrap transaction
        const unwrapBlockhash = await connection.getLatestBlockhash('confirmed');
        const unwrapTransaction = new Transaction().add(unwrapInstruction);
        unwrapTransaction.feePayer = payer;
        unwrapTransaction.recentBlockhash = unwrapBlockhash.blockhash;
        
        console.log('[removeDexLiquidity] 💰 Sending unwrap transaction to convert wSOL to native SOL for token B');
        const unwrapSignature = await wallet.sendTransaction(unwrapTransaction, connection, {
          skipPreflight: false
        });
        
        await waitForSignatureConfirmation(
          connection,
          unwrapSignature,
          unwrapBlockhash.blockhash,
          unwrapBlockhash.lastValidBlockHeight
        );
        
        console.log('[removeDexLiquidity] ✅ Successfully unwrapped wSOL to native SOL for token B');
        console.log('[removeDexLiquidity] Unwrap signature:', unwrapSignature);
      } else {
        console.log('[removeDexLiquidity] ⚠️ wSOL B balance is 0, skipping unwrap');
      }
    } catch (unwrapError: any) {
      console.error('[removeDexLiquidity] ❌ Failed to unwrap wSOL B to SOL:', unwrapError);
      console.error('[removeDexLiquidity] ⚠️ Liquidity removal succeeded but unwrap failed - user has wSOL instead of SOL');
      // Don't throw - liquidity removal succeeded, just unwrap failed
    }
  }
  
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
  const { connection, wallet } = params;
  const payer = wallet.publicKey!;
  
  const originalTokenA = typeof params.tokenA === 'string' ? new PublicKey(params.tokenA) : params.tokenA;
  const originalTokenB = typeof params.tokenB === 'string' ? new PublicKey(params.tokenB) : params.tokenB;
  
  // SOL HANDLING: Detect if tokens are SOL (wSOL mint)
  // Note: In pools, SOL is stored as wSOL (NATIVE_SOL_MINT), so we check for that
  const originalTokenAIsSOL = isNativeSol(originalTokenA);
  const originalTokenBIsSOL = isNativeSol(originalTokenB);
  
  // Convert SOL to wSOL mint for pool operations (pools use wSOL mint)
  let tokenA = originalTokenAIsSOL ? NATIVE_SOL_MINT : originalTokenA;
  let tokenB = originalTokenBIsSOL ? NATIVE_SOL_MINT : originalTokenB;
  
  if (originalTokenAIsSOL) {
    console.log('[swapDex] ⚡ Token A is SOL - using wSOL mint');
  }
  if (originalTokenBIsSOL) {
    console.log('[swapDex] ⚡ Token B is SOL - using wSOL mint');
  }
  
  // Ensure canonical order
  const canonicalOrder = tokenA.toBuffer().compare(tokenB.toBuffer()) < 0;
  const [tokenAMint, tokenBMint] = canonicalOrder ? [tokenA, tokenB] : [tokenB, tokenA];
  
  // Determine which direction we're swapping
  // If params.aToB is true and tokenA < tokenB, we're swapping A -> B
  // If params.aToB is true and tokenA > tokenB, we're swapping B -> A (so aToB should be false)
  const actualAToB = canonicalOrder === params.aToB;
  
  // Determine if input/output are SOL (after canonical ordering)
  const inputIsOriginalA = (actualAToB && canonicalOrder) || (!actualAToB && !canonicalOrder);
  const outputIsOriginalA = (actualAToB && !canonicalOrder) || (!actualAToB && canonicalOrder);
  const tokenInIsSOL = inputIsOriginalA ? originalTokenAIsSOL : originalTokenBIsSOL;
  const tokenOutIsSOL = outputIsOriginalA ? originalTokenAIsSOL : originalTokenBIsSOL;
  
  if (tokenInIsSOL) {
    console.log('[swapDex] ⚡ Input token is SOL - will wrap to wSOL before swap');
  }
  if (tokenOutIsSOL) {
    console.log('[swapDex] ⚡ Output token is SOL - will unwrap wSOL to SOL after swap');
  }
  
  // Get pool state
  const poolState = deriveDexPoolState(tokenAMint, tokenBMint);
  const poolStateData = await getDexPoolState(connection, tokenAMint, tokenBMint);
  if (!poolStateData) {
    throw new Error('Pool does not exist.');
  }
  
  // Determine input/output tokens based on swap direction
  const tokenInMint = actualAToB ? tokenAMint : tokenBMint;
  const tokenOutMint = actualAToB ? tokenBMint : tokenAMint;
  const tokenInIsZtoken = actualAToB ? poolStateData.tokenAIsZtoken : poolStateData.tokenBIsZtoken;
  const tokenOutIsZtoken = actualAToB ? poolStateData.tokenBIsZtoken : poolStateData.tokenAIsZtoken;
  
  // Get wSOL accounts if needed
  let wsolTokenAccountIn: PublicKey | null = null;
  let wsolTokenAccountOut: PublicKey | null = null;
  
  if (tokenInIsSOL) {
    wsolTokenAccountIn = await getWrappedSolAccount(payer);
    console.log('[swapDex] wSOL token account for input:', wsolTokenAccountIn.toBase58());
  }
  
  if (tokenOutIsSOL) {
    wsolTokenAccountOut = await getWrappedSolAccount(payer);
    console.log('[swapDex] wSOL token account for output:', wsolTokenAccountOut.toBase58());
  }
  
  // Get token accounts
  // If SOL was detected, use wSOL token account directly, otherwise derive ATA
  const userTokenInAccount = (tokenInIsSOL && wsolTokenAccountIn)
    ? wsolTokenAccountIn // Use wSOL account if SOL input
    : await getAssociatedTokenAddress(
        tokenInMint,
        payer,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
  const poolTokenInAccount = await getAssociatedTokenAddress(
    tokenInMint, // Will be wSOL mint if SOL was detected
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  const userTokenOutAccount = (tokenOutIsSOL && wsolTokenAccountOut)
    ? wsolTokenAccountOut // Use wSOL account if SOL output
    : await getAssociatedTokenAddress(
        tokenOutMint,
        payer,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
  const poolTokenOutAccount = await getAssociatedTokenAddress(
    tokenOutMint, // Will be wSOL mint if SOL was detected
    poolState,
    true, // allowOwnerOffCurve - poolState is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Build instruction
  const instructions: TransactionInstruction[] = [];
  
  // SOL WRAPPING: Add wrap instructions BEFORE swap if input is SOL
  // Use existing wSOL balance first, then wrap only what's needed
  if (tokenInIsSOL && wsolTokenAccountIn) {
    console.log('[swapDex] 🔄 Checking wSOL balance for input - will use existing wSOL first');
    const balanceCheck = await checkWrappedSolBalance(connection, payer, params.amountIn);
    if (!balanceCheck.hasEnough) {
      const wrapAmount = balanceCheck.needsWrap;
      console.log('[swapDex] Existing wSOL input balance:', balanceCheck.currentBalance.toString(), 'lamports');
      console.log('[swapDex] 💰 Wrapping', wrapAmount.toString(), 'additional lamports of SOL to wSOL for input');
      const wrapInstructions = await createWrapSolInstructions(
        wsolTokenAccountIn,
        wrapAmount,
        payer,
        connection
      );
      instructions.push(...wrapInstructions);
    } else {
      console.log('[swapDex] ✅ Sufficient wSOL input balance - using existing wSOL');
    }
  }
  
  // Ensure output token account exists (for public tokens only)
  // If SOL output, wSOL account should already exist (created during pool creation/liquidity addition)
  if (!tokenOutIsZtoken && !tokenOutIsSOL) {
    const userTokenOutAccountInfo = await connection.getAccountInfo(userTokenOutAccount, 'confirmed');
    if (!userTokenOutAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          payer,
          userTokenOutAccount,
          payer,
          tokenOutMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }
  
  // Encode swap instruction
  // Use snake_case to match IDL
  const swapData = dexCoder.instruction.encode('swap', {
    amount_in: new BN(params.amountIn.toString()),
    min_amount_out: new BN(params.minAmountOut.toString()),
    a_to_b: actualAToB,
    transfer_args_in: null,  // Optional: null for public tokens, TransferArgs for zToken input
    shield_args_out: null,   // Optional: null for public tokens, ShieldArgs for zToken output (Public → zToken)
    transfer_args_out: null  // Optional: null for public tokens, TransferArgs for zToken output (zToken → zToken)
  });
  
  // Build instruction keys
  const instructionKeys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: tokenAMint, isSigner: false, isWritable: false },
    { pubkey: tokenBMint, isSigner: false, isWritable: false },
    { pubkey: userTokenInAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenInAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenOutAccount, isSigner: false, isWritable: true },
    { pubkey: poolTokenOutAccount, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false } // rent (required by IDL)
  ];
  
  // Add zToken pool accounts to remaining_accounts if needed
  // Swap types:
  // 1. Public → Public: No zToken accounts needed ✅
  // 2. Public → zToken: Shield accounts for output (14 accounts)
  // 3. zToken → Public: Transfer accounts for input (7 accounts)
  // 4. zToken → zToken: Transfer accounts for input (7) + Transfer accounts for output (7)
  
  let accountsOffset = 0;
  
  // Handle zToken input (transfer from user to pool PDA)
  if (tokenInIsZtoken) {
    console.info('[swapDex] Token in is zToken - adding transfer accounts (user → pool PDA)');
    const zTokenAccountsIn = getZTokenPoolAccounts(tokenInMint, false); // forShield = false (transfer)
    
    instructionKeys.push(...zTokenAccountsIn.map(pubkey => ({ 
      pubkey, 
      isSigner: false, 
      isWritable: true
    })));
    
    accountsOffset += zTokenAccountsIn.length;
    console.info(`[swapDex] Added ${zTokenAccountsIn.length} accounts for zToken input transfer`);
    
    // TODO: Generate transfer proof for input
    if (params.zTokenInputNotes && params.proofClient) {
      console.info('[swapDex] NOTE: Transfer proof generation pending - TransferArgs need to be added to instruction signature');
    } else if (tokenInIsZtoken) {
      console.warn('[swapDex] zToken input requires notes and proofClient for transfer proof generation');
    }
  }
  
  // Handle zToken output
  if (tokenOutIsZtoken) {
    if (!tokenInIsZtoken) {
      // Public → zToken: Shield output (14 accounts)
      console.info('[swapDex] Token out is zToken (Public → zToken) - adding shield accounts');
      const zTokenAccountsOut = getZTokenPoolAccounts(tokenOutMint, true); // forShield = true
      
      instructionKeys.push(...zTokenAccountsOut.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true
      })));
      
      // Add vault_token_account and depositor_token_account (pool's public token account)
      const vaultStateOut = deriveVaultState(tokenOutMint);
      const vaultTokenAccountOut = await getAssociatedTokenAddress(
        tokenOutMint,
        vaultStateOut,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      instructionKeys.push(
        { pubkey: vaultTokenAccountOut, isSigner: false, isWritable: true },
        { pubkey: poolTokenOutAccount, isSigner: false, isWritable: true } // depositor_token_account (pool's public token account)
      );
      
      console.info(`[swapDex] Added ${zTokenAccountsOut.length + 2} accounts for zToken output shield`);
      
      // TODO: Generate shield proof for output
      if (params.proofClient) {
        console.info('[swapDex] NOTE: Shield proof generation pending - ShieldArgs need to be added to instruction signature');
      }
    } else {
      // zToken → zToken: Transfer output (pool PDA → user) (7 accounts)
      console.info('[swapDex] Token out is zToken (zToken → zToken) - adding transfer accounts (pool PDA → user)');
      const zTokenAccountsOut = getZTokenPoolAccounts(tokenOutMint, false); // forShield = false (transfer)
      
      instructionKeys.push(...zTokenAccountsOut.map(pubkey => ({ 
        pubkey, 
        isSigner: false, 
        isWritable: true
      })));
      
      console.info(`[swapDex] Added ${zTokenAccountsOut.length} accounts for zToken output transfer`);
      
      // TODO: Generate transfer proof for output (pool PDA is sender)
      if (params.proofClient) {
        console.info('[swapDex] NOTE: Transfer proof generation pending - TransferArgs need to be added to instruction signature');
      }
    }
  }
  
  // Add payer, system_program, rent to remaining_accounts if zToken accounts were added
  // This ensures all AccountInfos have the same lifetime scope, avoiding Rust borrow checker conflicts
  if (tokenInIsZtoken || tokenOutIsZtoken) {
    instructionKeys.push(
      { pubkey: payer, isSigner: true, isWritable: true }, // payer (signer for CPI)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false } // rent
    );
    
    console.info('[swapDex] Added payer, system_program, rent to remaining_accounts (unified lifetime scope)');
  }
  
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
  
  // SOL UNWRAPPING: If output is SOL, unwrap wSOL to native SOL after swap
  if (tokenOutIsSOL && wsolTokenAccountOut) {
    console.log('[swapDex] 🔄 Swap complete, now unwrapping wSOL to native SOL for output');
    
    try {
      // Check if wSOL account has balance before unwrapping
      const wsolBalance = await getWrappedSolBalance(connection, payer);
      console.log('[swapDex] wSOL output balance after swap:', wsolBalance.toString(), 'lamports');
      
      if (wsolBalance > 0n) {
        // Create unwrap instruction
        const unwrapInstruction = createUnwrapSolInstruction(
          wsolTokenAccountOut,
          payer // Owner who will receive native SOL
        );
        
        // Send unwrap transaction
        const unwrapBlockhash = await connection.getLatestBlockhash('confirmed');
        const unwrapTransaction = new Transaction().add(unwrapInstruction);
        unwrapTransaction.feePayer = payer;
        unwrapTransaction.recentBlockhash = unwrapBlockhash.blockhash;
        
        console.log('[swapDex] 💰 Sending unwrap transaction to convert wSOL to native SOL');
        const unwrapSignature = await wallet.sendTransaction(unwrapTransaction, connection, {
          skipPreflight: false
        });
        
        await waitForSignatureConfirmation(
          connection,
          unwrapSignature,
          unwrapBlockhash.blockhash,
          unwrapBlockhash.lastValidBlockHeight
        );
        
        console.log('[swapDex] ✅ Successfully unwrapped wSOL to native SOL');
        console.log('[swapDex] ✅ Complete flow: SOL → wSOL → swap → wSOL → SOL');
        console.log('[swapDex] Unwrap signature:', unwrapSignature);
        
        return unwrapSignature; // Return unwrap signature as it's the final transaction
      } else {
        console.log('[swapDex] ⚠️ wSOL output balance is 0, skipping unwrap');
      }
    } catch (unwrapError: any) {
      console.error('[swapDex] ❌ Failed to unwrap wSOL to SOL:', unwrapError);
      console.error('[swapDex] ⚠️ Swap succeeded but unwrap failed - user has wSOL instead of SOL');
      // Don't throw - swap succeeded, just unwrap failed
      // User will have wSOL instead of SOL, but the swap was successful
    }
  }
  
  return signature;
}
