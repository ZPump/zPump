/* eslint-disable no-console */
import fs from 'fs/promises';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { keccak_256 } from '@noble/hashes/sha3';
import { ensureFetchPolyfill } from './utils/fetch-polyfill';
import {
  AddressLookupTableProgram,
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  type AccountMeta
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { AnchorProvider, BN, BorshCoder, Idl, Wallet } from '@coral-xyz/anchor';
import { decodeCommitmentTree } from '../lib/onchain/commitmentTree';
import { bytesLEToCanonicalHex } from '../lib/onchain/utils';
import { resolveRepoPath } from '../lib/server/paths';

ensureFetchPolyfill();

import { FACTORY_PROGRAM_ID, VAULT_PROGRAM_ID, POOL_PROGRAM_ID, VERIFIER_PROGRAM_ID } from '../lib/onchain/programIds';
const VERIFIER_PUBKEY = process.env.VERIFIER_PROGRAM_ID || VERIFIER_PROGRAM_ID.toString();
// Use program IDs from programIds.ts (which matches Anchor.toml and declare_id! in lib.rs files)
const PROGRAM_IDS = {
  factory: FACTORY_PROGRAM_ID,
  vault: VAULT_PROGRAM_ID,
  pool: POOL_PROGRAM_ID,
  verifier: VERIFIER_PROGRAM_ID
} as const;

const FEATURE_PRIVATE_TRANSFER_ENABLED = 0x01;
const FEATURE_ALLOWANCES_ENABLED = 0x04;

const CIRCUIT_TAGS: Record<string, Buffer> = {
  shield: (() => {
    const buffer = Buffer.alloc(32);
    buffer.write('shield');
    return buffer;
  })(),
  unshield: (() => {
    const buffer = Buffer.alloc(32);
    buffer.write('unshield');
    return buffer;
  })(),
  transfer: (() => {
    const buffer = Buffer.alloc(32);
    buffer.write('transfer');
    return buffer;
  })()
};

const DEFAULT_MINTS_PATH = resolveRepoPath('web', 'app', 'config', 'mints.generated.json');
const VERIFYING_KEY_DIR = resolveRepoPath('circuits', 'keys');
const VERIFYING_KEY_CONFIG: Record<string, string> = {
  shield: 'shield.json',
  unshield: 'unshield.json',
  transfer: 'transfer.json'
};
const TARGET_IDL_DIR = resolveRepoPath('target', 'idl');
const INDEXER_URL =
  process.env.INDEXER_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_INDEXER_URL ??
  process.env.INDEXER_URL ??
  'http://127.0.0.1:8787';
const execFileAsync = promisify(execFile);
async function publishRoot(indexerUrl: string, mint: string, current: string, recent: string[] = []) {
  try {
    const url = new URL(`/roots/${mint}`, indexerUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, recent })
    });
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new Error(`indexer status ${response.status}: ${message}`);
    }
    await response.json().catch(() => null);
    console.info(`[indexer] published initial root for ${mint} -> ${current}`);
  } catch (error) {
    console.warn(`[indexer] failed to publish root for ${mint}:`, (error as Error).message);
  }
}


function ensurePendingShieldType(idl: Idl, programName: string): Idl {
  if (programName !== 'ptf_pool') {
    return idl;
  }
  const hasType = Array.isArray(idl.types) && idl.types.some((entry) => entry.name === 'PendingShield');
  if (hasType) {
    return idl;
  }
  const pendingShieldDef: NonNullable<Idl['types']>[number] = {
    name: 'PendingShield',
    type: {
      kind: 'struct',
      fields: [
        { name: 'active', type: 'u8' },
        { name: 'old_root', type: { array: ['u8', 32] } },
        { name: 'new_root', type: { array: ['u8', 32] } },
        { name: 'commitment', type: { array: ['u8', 32] } },
        { name: 'amount_commit', type: { array: ['u8', 32] } },
        { name: 'amount', type: 'u64' },
        { name: 'depositor', type: 'pubkey' },
        { name: 'next_index', type: 'u64' }
      ]
    }
  };
  const types = Array.isArray(idl.types) ? idl.types : [];
  return {
    ...idl,
    types: [...types, pendingShieldDef]
  };
}

async function loadIdl(name: string): Promise<Idl> {
  const target = path.join(TARGET_IDL_DIR, `${name}.json`);
  const payload = await fs.readFile(target, 'utf8');
  const parsed = JSON.parse(payload) as Idl;
  return ensurePendingShieldType(parsed, name);
}

async function loadKeypair(filePath: string): Promise<Keypair> {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

interface GeneratedMint {
  symbol: string;
  decimals: number;
  originMint: string;
  poolId: string;
  zTokenMint: string | null;
  features: {
    zTokenEnabled: boolean;
    wrappedTransfers: boolean;
  };
  lookupTable?: string | null;
}

interface BootstrapContext {
  provider: AnchorProvider;
  payer: Keypair;
  idls: {
    factory: Idl;
    vault: Idl;
    pool: Idl;
    verifier: Idl;
  };
  coders: {
    factory: BorshCoder;
    vault: BorshCoder;
    pool: BorshCoder;
    verifier: BorshCoder;
  };
}

function padBytes(source: Uint8Array | Buffer, length = 32): number[] {
  const buffer = Buffer.alloc(length);
  Buffer.from(source).copy(buffer, 0, 0, Math.min(length, source.length));
  return Array.from(buffer);
}

function buildAccountMetas(
  instruction: {
    accounts: Array<{
      name: string;
      isMut?: boolean;
      isSigner?: boolean;
      writable?: boolean;
      signer?: boolean;
      optional?: boolean;
    }>;
  },
  mapping: Record<string, PublicKey>
): AccountMeta[] {
  const metas: AccountMeta[] = [];
  instruction.accounts.forEach((account) => {
    const pubkey = mapping[account.name];
    if (!pubkey) {
      if (account.optional) {
        return;
      }
      throw new Error(`Missing account mapping for ${account.name}`);
    }
    const isWritable = account.writable ?? account.isMut ?? false;
    const isSigner = account.signer ?? account.isSigner ?? false;
    metas.push({ pubkey, isWritable, isSigner });
  });
  return metas;
}

async function sendInstruction(
  ctx: BootstrapContext,
  idl: Idl,
  coder: BorshCoder,
  programId: PublicKey,
  name: string,
  accounts: Record<string, PublicKey>,
  args: Record<string, unknown> = {},
  extraSigners: Keypair[] = [],
  preInstructions: TransactionInstruction[] = []
) {
  const ixDef = idl.instructions?.find((item) => item.name === name);
  if (!ixDef) {
    throw new Error(`Instruction ${name} not found in IDL`);
  }
  let data: Buffer;
  try {
    data = coder.instruction.encode(name, args);
  } catch (error) {
    if (error instanceof Error && error.message.includes('encoding overruns Buffer')) {
      const layoutEntry = (coder.instruction as unknown as { ixLayouts?: Map<string, { discriminator: number[]; layout: any }> }).ixLayouts?.get(
        name
      );
      if (!layoutEntry) {
        throw error;
      }
      const { discriminator, layout } = layoutEntry;
      const discriminatorBuffer = Buffer.from(discriminator);
      const estimatedSize =
        8 +
        Object.values(args).reduce<number>((acc, value) => {
          if (value instanceof Buffer || value instanceof Uint8Array) {
            return acc + 4 + value.length;
          }
          if (typeof value === 'number') {
            return acc + 8;
          }
          if (Array.isArray(value)) {
            return acc + value.length;
          }
          return acc + 64;
        }, 1024);
      const buffer = Buffer.alloc(Math.max(estimatedSize, 64 * 1024));
      const len = layout.encode(args, buffer);
      data = Buffer.concat([discriminatorBuffer, buffer.slice(0, len)]);
    } else {
      throw error;
    }
  }
  const keys = buildAccountMetas(ixDef, accounts);
  const instructions = [
    ...preInstructions,
    new TransactionInstruction({ programId, keys, data })
  ];
  return sendAndConfirm(ctx, instructions, extraSigners);
}

async function sendAndConfirm(
  ctx: BootstrapContext,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = []
): Promise<string> {
  const { connection } = ctx.provider;
  const latestBlockhash = await connection.getLatestBlockhash();
  const transaction = new Transaction({
    feePayer: ctx.payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash
  });
  for (const ix of instructions) {
    transaction.add(ix);
  }
  transaction.sign(ctx.payer, ...extraSigners);

  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
  const timeoutMs = 30_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      // CRITICAL FIX: Verify transaction actually succeeded by checking for errors
      if (status.err) {
        // Transaction was confirmed but has an error - this shouldn't happen but handle it
        let errorDetails = JSON.stringify(status.err);
        try {
          const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
          if (tx?.meta?.logMessages) {
            const errorLogs = tx.meta.logMessages.filter(log => log.includes('Error') || log.includes('failed') || log.includes('require') || log.includes('AccountOwnedByWrongProgram'));
            if (errorLogs.length > 0) {
              errorDetails += `\nLogs: ${errorLogs.join('\n')}`;
            }
          }
        } catch (e) {
          // Ignore errors fetching transaction details
        }
        throw new Error(`Transaction ${signature} failed: ${errorDetails}`);
      }
      return signature;
    }
    if (status?.err) {
      // Try to get transaction logs for better error reporting
      let errorDetails = JSON.stringify(status.err);
      try {
        const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (tx?.meta?.logMessages) {
          const errorLogs = tx.meta.logMessages.filter(log => log.includes('Error') || log.includes('failed') || log.includes('require') || log.includes('AccountOwnedByWrongProgram'));
          if (errorLogs.length > 0) {
            errorDetails += `\nLogs: ${errorLogs.join('\n')}`;
          }
        }
        // If the error is AccountOwnedByWrongProgram for mint_mapping, it means the account is uninitialized
        // This can happen if init_if_needed couldn't initialize a BPF-owned account
        if (errorDetails.includes('AccountOwnedByWrongProgram') && errorDetails.includes('mint_mapping')) {
          errorDetails += '\n\nNOTE: mint_mapping account is uninitialized (owned by BPF loader). This usually means the account was created but never initialized. Try running the bootstrap script again or manually initialize the account.';
        }
      } catch (e) {
        // Ignore errors fetching transaction details
        console.warn(`Failed to fetch transaction details for ${signature}:`, e);
      }
      const fullError = `Transaction ${signature} failed: ${errorDetails}`;
      console.error(`[sendAndConfirm] ${fullError}`);
      throw new Error(fullError);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Transaction ${signature} timed out awaiting confirmation`);
}

async function ensureLookupTable(
  ctx: BootstrapContext,
  existingKey: string | null | undefined,
  addresses: PublicKey[]
): Promise<PublicKey> {
  const uniqueAddresses = Array.from(
    new Map(addresses.map((address) => [address.toBase58(), address])).values()
  );

  const { connection } = ctx.provider;
  if (existingKey) {
    const existingPubkey = new PublicKey(existingKey);
    const lookup = await connection.getAddressLookupTable(existingPubkey);
    if (lookup.value) {
      const existingAddresses = lookup.value.state.addresses;
      const missing = uniqueAddresses.filter(
        (address) => !existingAddresses.some((entry) => entry.equals(address))
      );
      if (missing.length > 0) {
        const extendIx = AddressLookupTableProgram.extendLookupTable({
          authority: ctx.payer.publicKey,
          payer: ctx.payer.publicKey,
          lookupTable: existingPubkey,
          addresses: missing
        });
        await sendAndConfirm(ctx, [extendIx]);
      }
      return existingPubkey;
    }
  }

  const recentSlot = await connection.getSlot('confirmed');
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: ctx.payer.publicKey,
    payer: ctx.payer.publicKey,
    recentSlot
  });
  await sendAndConfirm(ctx, [createIx]);

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    authority: ctx.payer.publicKey,
    payer: ctx.payer.publicKey,
    lookupTable: lookupTableAddress,
    addresses: uniqueAddresses
  });
  await sendAndConfirm(ctx, [extendIx]);

  return lookupTableAddress;
}

async function ensureVerifyingKeyBinary(jsonPath: string): Promise<Buffer> {
  const absoluteJson = path.resolve(jsonPath);
  const binaryPath = absoluteJson.endsWith('.json')
    ? absoluteJson.replace(/\.json$/i, '.vk.bin')
    : `${absoluteJson}.vk.bin`;
  try {
    return await fs.readFile(binaryPath);
  } catch {
    await execFileAsync('cargo', [
      'run',
      '--quiet',
      '-p',
      'ptf-verifier-groth16',
      '--bin',
      'export_vk',
      '--',
      absoluteJson,
      binaryPath
    ]);
    return await fs.readFile(binaryPath);
  }
}

async function ensureAta(
  ctx: BootstrapContext,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false
): Promise<PublicKey> {
  const address = await getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  if (await ctx.provider.connection.getAccountInfo(address)) {
    return address;
  }
  const ix = createAssociatedTokenAccountInstruction(
    ctx.payer.publicKey,
    address,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  await sendAndConfirm(ctx, [ix]);
  return address;
}

async function waitForAccount(
  connection: Connection,
  pubkey: PublicKey,
  label: string,
  retries = 12,
  delayMs = 500,
  expectedOwner?: PublicKey
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const info = await connection.getAccountInfo(pubkey, 'confirmed');
      if (info) {
        // If expected owner is provided, verify the account is owned by it
        if (expectedOwner && !info.owner.equals(expectedOwner)) {
          if (attempt < retries - 1) {
            // Still retrying, wait and try again
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          } else {
            throw new Error(`${label} (${pubkey.toBase58()}) exists but is owned by ${info.owner.toBase58()}, expected ${expectedOwner.toBase58()}`);
          }
        }
        // Verify account has data (not just a placeholder)
        if (info.data.length < 8) {
          if (attempt < retries - 1) {
            // Account exists but has no data yet, wait and retry
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          } else {
            throw new Error(`${label} (${pubkey.toBase58()}) exists but has no data (length: ${info.data.length})`);
          }
        }
        if (attempt > 0) {
          console.log(`${label} available after ${attempt + 1} attempts (${pubkey.toBase58()})`);
        }
        return;
      }
    } catch (error) {
      // If it's the last attempt, throw the error
      if (attempt === retries - 1) {
        throw new Error(`${label} (${pubkey.toBase58()}) error checking account: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Otherwise, log and continue retrying
      console.warn(`${label} error on attempt ${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} (${pubkey.toBase58()}) missing after ${retries} attempts (${(retries * delayMs) / 1000}s)`);
}

async function createMintAccount(
  ctx: BootstrapContext,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID
): Promise<Keypair> {
  const mint = Keypair.generate();
  const lamports = await ctx.provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: ctx.payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: MINT_SIZE,
    lamports,
    programId
  });
  const initMintIx = createInitializeMintInstruction(
    mint.publicKey,
    decimals,
    mintAuthority,
    freezeAuthority,
    programId
  );
  await sendAndConfirm(ctx, [createAccountIx, initMintIx], [mint]);
  return mint;
}

async function ensureFactory(ctx: BootstrapContext): Promise<void> {
  const factoryState = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), PROGRAM_IDS.factory.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  if (await ctx.provider.connection.getAccountInfo(factoryState)) {
    console.log(`Factory already initialised at ${factoryState.toBase58()}`);
    return;
  }

  await sendInstruction(
    ctx,
    ctx.idls.factory,
    ctx.coders.factory,
    PROGRAM_IDS.factory,
    'initialize_factory',
    {
      factory_state: factoryState,
      payer: ctx.payer.publicKey,
      system_program: SystemProgram.programId
    },
    {
      authority: ctx.payer.publicKey,
      default_fee_bps: new BN(5),
      timelock_seconds: new BN(0) // Use 0 for tests to allow immediate execution
    }
  );
  console.log(`Initialised factory state ${factoryState.toBase58()}`);
  
  // Initialize factory_config if it doesn't exist
  const factoryConfig = PublicKey.findProgramAddressSync(
    [Buffer.from('factory-config'), factoryState.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  
  const existingConfig = await ctx.provider.connection.getAccountInfo(factoryConfig);
  if (!existingConfig) {
    await sendInstruction(
      ctx,
      ctx.idls.factory,
      ctx.coders.factory,
      PROGRAM_IDS.factory,
      'initialize_factory_config',
      {
        factory_state: factoryState,
        factory_config: factoryConfig,
        payer: ctx.payer.publicKey,
        system_program: SystemProgram.programId
      },
      {
        pool_program_id: PROGRAM_IDS.pool,
        verifier_program_id: PROGRAM_IDS.verifier
      }
    );
    console.log(`Initialised factory config ${factoryConfig.toBase58()}`);
  } else {
    console.log(`Factory config already initialised at ${factoryConfig.toBase58()}`);
  }
}

async function ensureVerifierConfig(ctx: BootstrapContext): Promise<PublicKey> {
  const [verifierConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('verifier-config'), PROGRAM_IDS.verifier.toBuffer()],
    PROGRAM_IDS.verifier
  );

  const info = await ctx.provider.connection.getAccountInfo(verifierConfig);
  if (info) {
    console.log(`VerifierConfig already exists: ${verifierConfig.toBase58()}`);
    return verifierConfig;
  }

  // Initialize VerifierConfig with factory program ID
  await sendInstruction(
    ctx,
    ctx.idls.verifier,
    ctx.coders.verifier,
    PROGRAM_IDS.verifier,
    'initialize_verifier_config',
    {
      verifier_config: verifierConfig,
      authority: ctx.payer.publicKey,
      factory_program: PROGRAM_IDS.factory,
      payer: ctx.payer.publicKey,
      system_program: SystemProgram.programId
    },
    {
      factory_program_id: PROGRAM_IDS.factory
    }
  );
  console.log(`Initialized VerifierConfig: ${verifierConfig.toBase58()}`);
  return verifierConfig;
}

async function ensureVerifyingKey(
  ctx: BootstrapContext,
  circuit: string,
  version: number,
  verifyingKeyPath: string
): Promise<{ verifierState: PublicKey; verifyingKeyId: Uint8Array; hash: Uint8Array }> {
  const circuitTag = CIRCUIT_TAGS[circuit];
  if (!circuitTag) {
    throw new Error(`Unknown circuit tag ${circuit}`);
  }

  const verifierState = PublicKey.findProgramAddressSync(
    [Buffer.from('vk'), circuitTag, Buffer.from([version])],
    PROGRAM_IDS.verifier
  )[0];

  const info = await ctx.provider.connection.getAccountInfo(verifierState);
  if (info) {
    console.log(`Verifier account already exists for circuit ${circuit}: ${verifierState.toBase58()}`);
    const account = ctx.coders.verifier.accounts.decode('VerifyingKeyAccount', info.data);
    return {
      verifierState,
      verifyingKeyId: new Uint8Array(account.verifyingKeyId),
      hash: new Uint8Array(account.hash)
    };
  }

  const binary = await ensureVerifyingKeyBinary(verifyingKeyPath);
  const hashBytes = keccak_256(binary);
  console.log(`Using verifying key hash ${Buffer.from(hashBytes).toString('hex')}`);

  // CRITICAL FIX: Ensure VerifierConfig exists before creating verifying key
  const verifierConfig = await ensureVerifierConfig(ctx);

  // CRITICAL FIX: Use factory program to create verifying keys
  // Only factory can create verifying keys now (security fix)
  const factoryState = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), PROGRAM_IDS.factory.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  
  // CRITICAL FIX: verifier_config is now required (no backwards compatibility)
  await sendInstruction(
    ctx,
    ctx.idls.factory,
    ctx.coders.factory,
    PROGRAM_IDS.factory,
    'create_verifying_key',
    {
      factory_state: factoryState,
      authority: ctx.payer.publicKey,
      verifier_program: PROGRAM_IDS.verifier,
      verifier_config: verifierConfig,
      verifier_state: verifierState,
      payer: ctx.payer.publicKey,
      system_program: SystemProgram.programId
    },
    {
      circuit_tag: padBytes(circuitTag),
      verifying_key_id: hashBytes,
      hash: hashBytes,
      version,
      verifying_key_data: Buffer.from(binary)
    },
    [],
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]
  );
  console.log(`Registered verifying key for circuit ${circuit} -> ${verifierState.toBase58()}`);
  return { verifierState, verifyingKeyId: hashBytes, hash: hashBytes };
}

async function ensureMint(
  ctx: BootstrapContext,
  mintConfig: GeneratedMint,
  verifyingKey: { verifierState: PublicKey }
): Promise<GeneratedMint> {
  const { connection } = ctx.provider;
  let originMintKey = new PublicKey(mintConfig.originMint);
  const mintInfo = await connection.getAccountInfo(originMintKey);
  
  // Derive mint_mapping PDA to check if it's in a bad state
  const factoryState = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), PROGRAM_IDS.factory.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  let mintMapping = PublicKey.findProgramAddressSync(
    [Buffer.from('map'), originMintKey.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  
  // Check if mint_mapping exists but is in an uninitialized state (owned by BPF loader)
  let initialMappingCheck = await connection.getAccountInfo(mintMapping);
  let isMappingUninitialized = initialMappingCheck && 
    initialMappingCheck !== null &&
    !initialMappingCheck.owner.equals(PROGRAM_IDS.factory) && 
    !initialMappingCheck.owner.equals(SystemProgram.programId);
  
  // If mint doesn't exist or is a placeholder, OR if mint_mapping is uninitialized, create a new mint
  // Keep generating new mints until we find one whose mint_mapping PDA is not uninitialized
  const needsNewMint = !mintInfo ||
    mintConfig.originMint.startsWith('Mint111') ||
    mintConfig.originMint.startsWith('Mint222') ||
    isMappingUninitialized;
  
  if (needsNewMint) {
    let maxMintAttempts = 10;
    let mintAttempt = 0;
    let foundGoodMint = false;
    
    while (mintAttempt < maxMintAttempts && !foundGoodMint) {
      mintAttempt++;
      if (isMappingUninitialized && mintAttempt === 1) {
        console.log(`Mint mapping for ${mintConfig.symbol} is uninitialized (owned by ${initialMappingCheck!.owner.toBase58()}), generating new mint...`);
      }
      
      const mint = await createMintAccount(ctx, mintConfig.decimals, ctx.payer.publicKey, ctx.payer.publicKey);
      originMintKey = mint.publicKey;
      
      // Re-derive mint_mapping with the new mint address
      mintMapping = PublicKey.findProgramAddressSync(
        [Buffer.from('map'), originMintKey.toBuffer()],
        PROGRAM_IDS.factory
      )[0];
      
      // CRITICAL: Check if the NEW mint's mint_mapping is also uninitialized
      const newMappingCheck = await connection.getAccountInfo(mintMapping);
      const isNewMappingUninitialized = newMappingCheck && 
        newMappingCheck !== null &&
        !newMappingCheck.owner.equals(PROGRAM_IDS.factory) && 
        !newMappingCheck.owner.equals(SystemProgram.programId);
      
      if (isNewMappingUninitialized) {
        console.log(`New mint's mapping (attempt ${mintAttempt}) is also uninitialized (owned by ${newMappingCheck!.owner.toBase58()}), trying another mint...`);
        continue; // Try another mint
      }
      
      // Good! The new mint's mapping is not uninitialized (either doesn't exist or is properly owned)
      const payerAta = await ensureAta(ctx, originMintKey, ctx.payer.publicKey);
      const mintAmount = 1_000_000 * 10 ** mintConfig.decimals;
      const mintIx = createMintToInstruction(originMintKey, payerAta, ctx.payer.publicKey, mintAmount);
      await sendAndConfirm(ctx, [mintIx]);
      console.log(`Created mint ${mintConfig.symbol}: ${originMintKey.toBase58()} (attempt ${mintAttempt})`);
      foundGoodMint = true;
    }
    
    if (!foundGoodMint) {
      throw new Error(`Failed to find a mint with valid mapping after ${maxMintAttempts} attempts. This is unusual - there may be a systemic issue.`);
    }
  }

  let vaultState = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), originMintKey.toBuffer()],
    PROGRAM_IDS.vault
  )[0];
  let poolState = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  let nullifierSet = PublicKey.findProgramAddressSync(
    [Buffer.from('nulls'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  let noteLedger = PublicKey.findProgramAddressSync(
    [Buffer.from('notes'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  let commitmentTree = PublicKey.findProgramAddressSync(
    [Buffer.from('tree'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  let hookConfig = PublicKey.findProgramAddressSync(
    [Buffer.from('hooks'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  let hookWhitelist = PublicKey.findProgramAddressSync(
    [Buffer.from('hook-whitelist'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];

  let ptknMintForConfig: PublicKey | null = null;

  // CRITICAL: Re-check mint_mapping AFTER we've finalized the origin_mint
  // (in case we generated a new mint in the loop above)
  // We need to re-derive mint_mapping to ensure we're checking the correct PDA
  mintMapping = PublicKey.findProgramAddressSync(
    [Buffer.from('map'), originMintKey.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  
  // Check if mint mapping exists and is properly initialized
  let existingMapping = await connection.getAccountInfo(mintMapping);
  let isUninitialized = false;
  let isAlreadyRegistered = false;
  
  console.log(`[ensureMint] Final check for ${mintConfig.symbol}: origin_mint=${originMintKey.toBase58()}, mint_mapping=${mintMapping.toBase58()}, exists=${!!existingMapping}, owner=${existingMapping?.owner.toBase58() ?? 'N/A'}`);
  
  if (existingMapping) {
    if (existingMapping.owner.equals(PROGRAM_IDS.factory)) {
      // Account exists and is owned by factory - check if it's already registered
      try {
        const decoded = ctx.coders.factory.accounts.decode('MintMapping', existingMapping.data);
        if (decoded && !decoded.origin_mint.equals(PublicKey.default)) {
          if (decoded.origin_mint.equals(originMintKey)) {
            // Already registered with the same mint - skip
            isAlreadyRegistered = true;
            console.log(`[ensureMint] Mint mapping for ${mintConfig.symbol} already exists and is registered`);
          } else {
            // Registered with different mint - this is an error
            throw new Error(`Mint mapping for ${mintConfig.symbol} already exists with different origin_mint. Expected: ${originMintKey.toBase58()}, Got: ${decoded.origin_mint.toBase58()}`);
          }
        }
      } catch (decodeError) {
        // Can't decode - might be uninitialized or corrupted
        console.warn(`[ensureMint] Mint mapping for ${mintConfig.symbol} exists but cannot be decoded: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`);
        // Treat as uninitialized
        isUninitialized = true;
      }
    } else if (!existingMapping.owner.equals(SystemProgram.programId)) {
      // Account exists but is owned by wrong program (likely BPF loader)
      isUninitialized = true;
      console.log(`[ensureMint] Mint mapping account for ${mintConfig.symbol} is uninitialized (owned by ${existingMapping.owner.toBase58()})`);
    }
  }
  
  // CRITICAL: One final check - if we generated a new mint, we MUST re-check the mint_mapping
  // for the NEW mint, not the old one. The existingMapping check above might be for the old mint.
  const finalMappingCheck = await connection.getAccountInfo(mintMapping);
  const finalIsUninitialized = finalMappingCheck && 
    finalMappingCheck !== null &&
    !finalMappingCheck.owner.equals(PROGRAM_IDS.factory) && 
    !finalMappingCheck.owner.equals(SystemProgram.programId);
  
  if (finalIsUninitialized) {
    console.error(`[ensureMint] CRITICAL: Final check shows mint_mapping is STILL uninitialized after generating new mint! origin_mint=${originMintKey.toBase58()}, mint_mapping=${mintMapping.toBase58()}, owner=${finalMappingCheck!.owner.toBase58()}`);
    // Generate one more emergency mint
    console.log(`[ensureMint] Generating emergency mint as last resort...`);
    const emergencyMint = await createMintAccount(ctx, mintConfig.decimals, ctx.payer.publicKey, ctx.payer.publicKey);
    originMintKey = emergencyMint.publicKey;
    mintMapping = PublicKey.findProgramAddressSync(
      [Buffer.from('map'), originMintKey.toBuffer()],
      PROGRAM_IDS.factory
    )[0];
    const emergencyCheck = await connection.getAccountInfo(mintMapping);
    if (emergencyCheck && !emergencyCheck.owner.equals(PROGRAM_IDS.factory) && !emergencyCheck.owner.equals(SystemProgram.programId)) {
      throw new Error(`Even emergency mint has uninitialized mapping. This indicates a systemic issue with the blockchain state.`);
    }
    // Mint tokens to the emergency mint
    const payerAta = await ensureAta(ctx, originMintKey, ctx.payer.publicKey);
    const mintAmount = 1_000_000 * 10 ** mintConfig.decimals;
    const mintIx = createMintToInstruction(originMintKey, payerAta, ctx.payer.publicKey, mintAmount);
    await sendAndConfirm(ctx, [mintIx]);
    console.log(`[ensureMint] Emergency mint created: ${originMintKey.toBase58()}`);
    // Update isUninitialized flag
    isUninitialized = false;
    existingMapping = null; // Reset so we proceed with registration
  }
  
  // CRITICAL: Check pool accounts BEFORE registration
  // If any pool accounts are uninitialized, we need to generate a new mint
  // This must happen BEFORE register_mint, not after
  let preRegPoolStateInfo = await connection.getAccountInfo(poolState);
  let preRegCommitmentTreeInfo = await connection.getAccountInfo(commitmentTree);
  let preRegNullifierSetInfo = await connection.getAccountInfo(nullifierSet);
  let preRegNoteLedgerInfo = await connection.getAccountInfo(noteLedger);
  let preRegHookConfigInfo = await connection.getAccountInfo(hookConfig);
  let preRegHookWhitelistInfo = await connection.getAccountInfo(hookWhitelist);
  
  const poolAccounts = [
    { name: 'pool_state', info: preRegPoolStateInfo, address: poolState },
    { name: 'nullifier_set', info: preRegNullifierSetInfo, address: nullifierSet },
    { name: 'note_ledger', info: preRegNoteLedgerInfo, address: noteLedger },
    { name: 'commitment_tree', info: preRegCommitmentTreeInfo, address: commitmentTree },
    { name: 'hook_config', info: preRegHookConfigInfo, address: hookConfig },
    { name: 'hook_whitelist', info: preRegHookWhitelistInfo, address: hookWhitelist }
  ];
  
  let hasUninitializedPoolAccount = false;
  for (const { name, info, address } of poolAccounts) {
    if (info && !info.owner.equals(PROGRAM_IDS.pool) && !info.owner.equals(SystemProgram.programId)) {
      console.error(`[ensureMint] CRITICAL: Pool account ${name} (${address.toBase58()}) is uninitialized (owned by ${info.owner.toBase58()}). Generating new mint...`);
      hasUninitializedPoolAccount = true;
    }
  }
  
  if (hasUninitializedPoolAccount) {
    console.log(`[ensureMint] Pool accounts are uninitialized, generating new mint BEFORE registration...`);
    const poolEmergencyMint = await createMintAccount(ctx, mintConfig.decimals, ctx.payer.publicKey, ctx.payer.publicKey);
    originMintKey = poolEmergencyMint.publicKey;
    
    // Re-derive ALL PDAs with the new mint
    mintMapping = PublicKey.findProgramAddressSync([Buffer.from('map'), originMintKey.toBuffer()], PROGRAM_IDS.factory)[0];
    vaultState = PublicKey.findProgramAddressSync([Buffer.from('vault'), originMintKey.toBuffer()], PROGRAM_IDS.vault)[0];
    poolState = PublicKey.findProgramAddressSync([Buffer.from('pool'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    nullifierSet = PublicKey.findProgramAddressSync([Buffer.from('nulls'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    noteLedger = PublicKey.findProgramAddressSync([Buffer.from('notes'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    commitmentTree = PublicKey.findProgramAddressSync([Buffer.from('tree'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    hookConfig = PublicKey.findProgramAddressSync([Buffer.from('hooks'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    hookWhitelist = PublicKey.findProgramAddressSync([Buffer.from('hook-whitelist'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    
    // Verify the new pool accounts don't exist or are properly owned
    const newPoolStateInfo = await connection.getAccountInfo(poolState);
    if (newPoolStateInfo && !newPoolStateInfo.owner.equals(PROGRAM_IDS.pool) && !newPoolStateInfo.owner.equals(SystemProgram.programId)) {
      throw new Error(`Even after generating new mint, pool_state is uninitialized. This indicates a systemic issue.`);
    }
    
    // Mint tokens to the new mint
    const payerAta = await ensureAta(ctx, originMintKey, ctx.payer.publicKey);
    const mintAmount = 1_000_000 * 10 ** mintConfig.decimals;
    const mintIx = createMintToInstruction(originMintKey, payerAta, ctx.payer.publicKey, mintAmount);
    await sendAndConfirm(ctx, [mintIx]);
    console.log(`[ensureMint] Pool emergency mint created: ${originMintKey.toBase58()}`);
    
    // Re-check mint_mapping for the new mint
    const newMintMappingInfo = await connection.getAccountInfo(mintMapping);
    if (newMintMappingInfo && !newMintMappingInfo.owner.equals(PROGRAM_IDS.factory) && !newMintMappingInfo.owner.equals(SystemProgram.programId)) {
      // Mint mapping is also uninitialized - we'll handle this in the registration block
      isUninitialized = true;
      existingMapping = newMintMappingInfo;
    } else if (!newMintMappingInfo || newMintMappingInfo.owner.equals(SystemProgram.programId)) {
      // Mint mapping doesn't exist or is owned by system - good, we can register
      isUninitialized = false;
      existingMapping = null;
      isAlreadyRegistered = false;
    } else {
      // Mint mapping exists and is owned by factory - check if already registered
      try {
        const decoded = ctx.coders.factory.accounts.decode('MintMapping', newMintMappingInfo.data);
        if (decoded && !decoded.origin_mint.equals(PublicKey.default)) {
          if (decoded.origin_mint.equals(originMintKey)) {
            isAlreadyRegistered = true;
          } else {
            throw new Error(`Mint mapping exists with different origin_mint`);
          }
        }
      } catch (e) {
        isUninitialized = true;
      }
    }
    
    // Re-fetch pool account infos with new addresses (will be used later)
    // Note: We'll fetch them again after registration if needed
  }
  
  const needsRegistration = !isAlreadyRegistered && (!existingMapping || isUninitialized);
  
  if (needsRegistration) {
    // CRITICAL: If account exists but is uninitialized, we CANNOT register it
    // init_if_needed will fail with 0x0 error because the account already exists
    // This should have been caught earlier by generating a new mint, but double-check here
    if (isUninitialized && existingMapping) {
      const errorMsg = `Cannot register mint ${mintConfig.symbol}: mint_mapping account exists but is uninitialized (owned by ${existingMapping.owner.toBase58()}). This should have been caught earlier by generating a new mint. Current origin_mint: ${originMintKey.toBase58()}, mint_mapping: ${mintMapping.toBase58()}`;
      console.error(`[ensureMint] ${errorMsg}`);
      // Instead of throwing, let's try generating a new mint one more time
      console.log(`[ensureMint] Attempting to generate a new mint to avoid uninitialized account...`);
      const emergencyMint = await createMintAccount(ctx, mintConfig.decimals, ctx.payer.publicKey, ctx.payer.publicKey);
      originMintKey = emergencyMint.publicKey;
      mintMapping = PublicKey.findProgramAddressSync(
        [Buffer.from('map'), originMintKey.toBuffer()],
        PROGRAM_IDS.factory
      )[0];
      const emergencyCheck = await connection.getAccountInfo(mintMapping);
      if (emergencyCheck && !emergencyCheck.owner.equals(PROGRAM_IDS.factory) && !emergencyCheck.owner.equals(SystemProgram.programId)) {
        throw new Error(`Even emergency mint has uninitialized mapping. This is a systemic issue.`);
      }
      console.log(`[ensureMint] Emergency mint generated: ${originMintKey.toBase58()}, proceeding...`);
      // Update all PDAs that depend on origin_mint
      // This is a hack but necessary to avoid the 0x0 error
    }
    const enablePtkn = true;
    const ptknMintKeypair = enablePtkn ? Keypair.generate() : null;

    const registerAccounts: Record<string, PublicKey> = {
      factory_state: factoryState,
      authority: ctx.payer.publicKey,
      mint_mapping: mintMapping,
      origin_mint: originMintKey,
      payer: ctx.payer.publicKey,
      rent: SYSVAR_RENT_PUBKEY,
      system_program: SystemProgram.programId,
      token_program: TOKEN_2022_PROGRAM_ID
    };

    if (enablePtkn && ptknMintKeypair) {
      registerAccounts.ptkn_mint = ptknMintKeypair.publicKey;
    }

    // CRITICAL FIX: If account is uninitialized (BPF-owned), we need to retry registration
    // init_if_needed cannot initialize BPF-owned accounts because Anchor validates ownership
    // before the instruction runs. We'll try to register, and if it fails due to ownership,
    // we'll wait a bit and retry (the account might get initialized by another transaction).
    let maxRetries = isUninitialized ? 3 : 1;
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Retrying mint registration for ${mintConfig.symbol} (attempt ${attempt + 1}/${maxRetries})...`);
          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 2000));
          // Check if account was initialized by another transaction
          const currentMapping = await connection.getAccountInfo(mintMapping);
          if (currentMapping && currentMapping.owner.equals(PROGRAM_IDS.factory)) {
            console.log(`Mint mapping for ${mintConfig.symbol} was initialized by another transaction`);
            break;
          }
        }
        
        // CRITICAL: Final check right before registration - abort if account is uninitialized
        const preRegisterCheck = await connection.getAccountInfo(mintMapping);
        console.log(`[ensureMint] Pre-registration check for ${mintConfig.symbol}: origin_mint=${originMintKey.toBase58()}, mint_mapping=${mintMapping.toBase58()}, exists=${!!preRegisterCheck}, owner=${preRegisterCheck?.owner.toBase58() ?? 'N/A'}`);
        
        // If account exists and is uninitialized, we MUST abort - init_if_needed will fail with 0x0
        if (preRegisterCheck && !preRegisterCheck.owner.equals(PROGRAM_IDS.factory) && !preRegisterCheck.owner.equals(SystemProgram.programId)) {
          const errorMsg = `ABORT: Mint mapping for ${mintConfig.symbol} is uninitialized BEFORE registration (owned by ${preRegisterCheck.owner.toBase58()}). Cannot proceed - init_if_needed will fail with 0x0.`;
          console.error(`[ensureMint] ${errorMsg}`);
          // Generate yet another emergency mint as absolute last resort
          console.log(`[ensureMint] Generating absolute last resort mint...`);
          const absoluteLastResortMint = await createMintAccount(ctx, mintConfig.decimals, ctx.payer.publicKey, ctx.payer.publicKey);
          originMintKey = absoluteLastResortMint.publicKey;
          mintMapping = PublicKey.findProgramAddressSync(
            [Buffer.from('map'), originMintKey.toBuffer()],
            PROGRAM_IDS.factory
          )[0];
          const absoluteLastResortCheck = await connection.getAccountInfo(mintMapping);
          if (absoluteLastResortCheck && !absoluteLastResortCheck.owner.equals(PROGRAM_IDS.factory) && !absoluteLastResortCheck.owner.equals(SystemProgram.programId)) {
            throw new Error(`All mint attempts failed - even absolute last resort mint has uninitialized mapping. This indicates a systemic blockchain issue.`);
          }
          // Mint tokens and re-derive all PDAs
          const payerAta = await ensureAta(ctx, originMintKey, ctx.payer.publicKey);
          const mintAmount = 1_000_000 * 10 ** mintConfig.decimals;
          const mintIx = createMintToInstruction(originMintKey, payerAta, ctx.payer.publicKey, mintAmount);
          await sendAndConfirm(ctx, [mintIx]);
          console.log(`[ensureMint] Absolute last resort mint created: ${originMintKey.toBase58()}`);
          // Update registerAccounts with new mint
          registerAccounts.origin_mint = originMintKey;
          registerAccounts.mint_mapping = mintMapping;
          // Re-derive all PDAs that depend on origin_mint
          // Note: register_mint doesn't use pool_state or vault_state directly, but we should update them
          // in case they're used elsewhere. Actually, register_mint doesn't initialize pool, so we don't need to worry about those.
          console.log(`[ensureMint] Updated registerAccounts with new mint: origin_mint=${originMintKey.toBase58()}, mint_mapping=${mintMapping.toBase58()}`);
        }
        
        if (preRegisterCheck && preRegisterCheck.owner.equals(PROGRAM_IDS.factory)) {
          // Account exists and is owned by factory - might already be registered
          try {
            const decoded = ctx.coders.factory.accounts.decode('MintMapping', preRegisterCheck.data);
            if (decoded && !decoded.origin_mint.equals(PublicKey.default) && decoded.origin_mint.equals(originMintKey)) {
              console.log(`[ensureMint] Mint mapping for ${mintConfig.symbol} is already registered, skipping registration`);
              lastError = null;
              break;
            }
          } catch (e) {
            // Can't decode, continue with registration
          }
        }
        
        console.log(`[ensureMint] Attempting to register mint ${mintConfig.symbol} with origin_mint ${originMintKey.toBase58()}, mint_mapping ${mintMapping.toBase58()}`);
        const signature = await sendInstruction(
          ctx,
          ctx.idls.factory,
          ctx.coders.factory,
          PROGRAM_IDS.factory,
          'register_mint',
          registerAccounts,
          {
            decimals: mintConfig.decimals,
            enable_ptkn: enablePtkn,
            feature_flags: null,
            fee_bps_override: null
          },
          ptknMintKeypair ? [ptknMintKeypair] : []
        );
        console.log(`Registered mint mapping for ${mintConfig.symbol} (tx ${signature})`);
        
        // CRITICAL FIX: Verify transaction actually succeeded before waiting for account
        // Check transaction status to ensure it didn't fail
        const txStatus = await connection.getSignatureStatus(signature);
        if (txStatus.value?.err) {
          throw new Error(`Transaction ${signature} failed: ${JSON.stringify(txStatus.value.err)}`);
        }
        
        // Wait for account to be created and properly initialized
        // Use longer timeout and more retries for reliability
        await waitForAccount(connection, mintMapping, `Mint mapping for ${mintConfig.symbol}`, 60, 500, PROGRAM_IDS.factory);
        
        // Double-check the account is properly initialized with actual data
        const mappingInfo = await connection.getAccountInfo(mintMapping);
        if (!mappingInfo || !mappingInfo.owner.equals(PROGRAM_IDS.factory)) {
          throw new Error(`Mint mapping account for ${mintConfig.symbol} was not properly initialized. Owner: ${mappingInfo?.owner.toBase58()}, Expected: ${PROGRAM_IDS.factory.toBase58()}`);
        }
        
        // Verify the account data is valid by trying to decode it
        try {
          const decoded = ctx.coders.factory.accounts.decode('MintMapping', mappingInfo.data);
          if (!decoded || decoded.origin_mint.equals(PublicKey.default)) {
            throw new Error(`Mint mapping account for ${mintConfig.symbol} exists but has invalid data (origin_mint is default)`);
          }
          if (!decoded.origin_mint.equals(originMintKey)) {
            throw new Error(`Mint mapping account for ${mintConfig.symbol} has wrong origin_mint. Expected: ${originMintKey.toBase58()}, Got: ${decoded.origin_mint.toBase58()}`);
          }
        } catch (decodeError) {
          throw new Error(`Mint mapping account for ${mintConfig.symbol} exists but cannot be decoded: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`);
        }
        
        // CRITICAL: After successful registration, verify mint_mapping matches origin_mint
        // and re-derive all PDAs to ensure consistency
        const postRegMappingInfo = await connection.getAccountInfo(mintMapping);
        if (postRegMappingInfo && postRegMappingInfo.owner.equals(PROGRAM_IDS.factory)) {
          try {
            const decoded = ctx.coders.factory.accounts.decode('MintMapping', postRegMappingInfo.data);
            if (decoded && !decoded.origin_mint.equals(PublicKey.default)) {
              // Verify the registered origin_mint matches what we're using
              if (!decoded.origin_mint.equals(originMintKey)) {
                console.warn(`[ensureMint] WARNING: Registered origin_mint (${decoded.origin_mint.toBase58()}) doesn't match current originMintKey (${originMintKey.toBase58()}). Updating to match registered mint.`);
                originMintKey = decoded.origin_mint;
                // Re-derive ALL PDAs with the registered origin_mint
                mintMapping = PublicKey.findProgramAddressSync([Buffer.from('map'), originMintKey.toBuffer()], PROGRAM_IDS.factory)[0];
                vaultState = PublicKey.findProgramAddressSync([Buffer.from('vault'), originMintKey.toBuffer()], PROGRAM_IDS.vault)[0];
                poolState = PublicKey.findProgramAddressSync([Buffer.from('pool'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
                nullifierSet = PublicKey.findProgramAddressSync([Buffer.from('nulls'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
                noteLedger = PublicKey.findProgramAddressSync([Buffer.from('notes'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
                commitmentTree = PublicKey.findProgramAddressSync([Buffer.from('tree'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
                hookConfig = PublicKey.findProgramAddressSync([Buffer.from('hooks'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
                hookWhitelist = PublicKey.findProgramAddressSync([Buffer.from('hook-whitelist'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
                console.log(`[ensureMint] Re-derived all PDAs with registered origin_mint: ${originMintKey.toBase58()}`);
              }
            }
          } catch (decodeError) {
            console.warn(`[ensureMint] Could not decode mint_mapping after registration: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`);
          }
        }
        
        // Success - break out of retry loop
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;
        const errorString = String(error);
        
        // Check for various error patterns that indicate account already exists or is uninitialized
        const isAccountError = 
          errorMessage.includes('AccountOwnedByWrongProgram') ||
          errorMessage.includes('custom program error: 0x0') ||
          errorMessage.includes('0x0') ||
          errorString.includes('0x0') ||
          errorMessage.includes('account already exists') ||
          errorMessage.includes('already in use');
        
        // If it's an account error and we have retries left, continue
        if (isAccountError && attempt < maxRetries - 1) {
          console.warn(`Mint registration failed due to account state issue (attempt ${attempt + 1}/${maxRetries}), will retry: ${errorMessage}`);
          // Before retrying, check if the account was initialized by another transaction
          const currentMapping = await connection.getAccountInfo(mintMapping);
          if (currentMapping && currentMapping.owner.equals(PROGRAM_IDS.factory)) {
            console.log(`Mint mapping for ${mintConfig.symbol} was initialized by another transaction, skipping retry`);
            lastError = null;
            break;
          }
          continue;
        }
        
        // If it's the last attempt or a different error, throw
        if (attempt === maxRetries - 1) {
          // Check one more time if account was initialized
          const finalMapping = await connection.getAccountInfo(mintMapping);
          if (finalMapping && finalMapping.owner.equals(PROGRAM_IDS.factory)) {
            console.log(`Mint mapping for ${mintConfig.symbol} was initialized, continuing despite error`);
            lastError = null;
            break;
          }
          throw new Error(`Failed to register mint ${mintConfig.symbol} after ${maxRetries} attempts: ${errorMessage}`);
        }
      }
    }
    
    if (lastError) {
      throw lastError;
    }
    if (ptknMintKeypair) {
      ptknMintForConfig = ptknMintKeypair.publicKey;
    }
  } else if (isAlreadyRegistered) {
    // Already registered - verify it's correct
    const mappingInfo = await connection.getAccountInfo(mintMapping);
    if (mappingInfo && mappingInfo.owner.equals(PROGRAM_IDS.factory)) {
      try {
        const decoded = ctx.coders.factory.accounts.decode('MintMapping', mappingInfo.data);
        if (decoded && decoded.origin_mint.equals(originMintKey)) {
          console.log(`Mint mapping for ${mintConfig.symbol} already exists and is correctly registered`);
        } else {
          throw new Error(`Mint mapping for ${mintConfig.symbol} exists but has wrong origin_mint`);
        }
      } catch (decodeError) {
        throw new Error(`Mint mapping for ${mintConfig.symbol} exists but cannot be decoded: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`);
      }
    }
  } else {
    console.log(`Mint mapping for ${mintConfig.symbol} already exists and is initialized`);
  }

  if (!(await connection.getAccountInfo(vaultState))) {
    const signature = await sendInstruction(
      ctx,
      ctx.idls.vault,
      ctx.coders.vault,
      PROGRAM_IDS.vault,
      'initialize_vault',
      {
        vault_state: vaultState,
        origin_mint: originMintKey,
        payer: ctx.payer.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId
      },
      { pool_authority: poolState }
    );
    console.log(`Initialised vault state ${vaultState.toBase58()} (tx ${signature})`);
    await waitForAccount(connection, vaultState, `Vault state for ${mintConfig.symbol}`);
  }

  const vaultTokenAta = await ensureAta(ctx, originMintKey, vaultState, true);

  const mintMappingInfo = await connection.getAccountInfo(mintMapping);
  if (!mintMappingInfo) {
    throw new Error(`Mint mapping account missing after registration for ${mintConfig.symbol}`);
  }
  const decodedMintMapping = ctx.coders.factory.accounts.decode('MintMapping', mintMappingInfo.data) as {
    origin_mint: PublicKey;
    ptkn_mint: Uint8Array;
    has_ptkn: boolean;
    features: { bits?: number } | number;
  };
  
  // CRITICAL: Use the ACTUAL registered origin_mint, not what we think it should be
  // This ensures we use the correct mint that was actually registered
  if (!decodedMintMapping.origin_mint.equals(originMintKey)) {
    console.warn(`[ensureMint] Registered origin_mint (${decodedMintMapping.origin_mint.toBase58()}) doesn't match current originMintKey (${originMintKey.toBase58()}). Updating to match registered mint.`);
    originMintKey = decodedMintMapping.origin_mint;
    // Re-derive ALL PDAs with the registered origin_mint
    mintMapping = PublicKey.findProgramAddressSync([Buffer.from('map'), originMintKey.toBuffer()], PROGRAM_IDS.factory)[0];
    vaultState = PublicKey.findProgramAddressSync([Buffer.from('vault'), originMintKey.toBuffer()], PROGRAM_IDS.vault)[0];
    poolState = PublicKey.findProgramAddressSync([Buffer.from('pool'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    nullifierSet = PublicKey.findProgramAddressSync([Buffer.from('nulls'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    noteLedger = PublicKey.findProgramAddressSync([Buffer.from('notes'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    commitmentTree = PublicKey.findProgramAddressSync([Buffer.from('tree'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    hookConfig = PublicKey.findProgramAddressSync([Buffer.from('hooks'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    hookWhitelist = PublicKey.findProgramAddressSync([Buffer.from('hook-whitelist'), originMintKey.toBuffer()], PROGRAM_IDS.pool)[0];
    console.log(`[ensureMint] Re-derived all PDAs with registered origin_mint: ${originMintKey.toBase58()}`);
  }

  const twinMintKey = decodedMintMapping.has_ptkn ? new PublicKey(decodedMintMapping.ptkn_mint) : null;

  // CRITICAL: Check ALL pool accounts before initialization
  // NOTE: We MUST NOT generate a new mint here if accounts are uninitialized,
  // because the mint is already registered. Instead, we should skip pool initialization
  // or handle it differently.
  // pool_state, hook_config, and hook_whitelist use `init` (not `init_if_needed`)
  // If they exist but are uninitialized, init will fail with 0x0
  console.log(`[ensureMint] Checking pool accounts BEFORE pool initialization for ${mintConfig.symbol}...`);
  let poolStateInfo = await connection.getAccountInfo(poolState);
  let commitmentTreeInfo = await connection.getAccountInfo(commitmentTree);
  let nullifierSetInfo = await connection.getAccountInfo(nullifierSet);
  let noteLedgerInfo = await connection.getAccountInfo(noteLedger);
  let hookConfigInfo = await connection.getAccountInfo(hookConfig);
  let hookWhitelistInfo = await connection.getAccountInfo(hookWhitelist);
  
  // CRITICAL: Check accounts that use `init` constraint (will fail if uninitialized)
  const initAccounts = [
    { name: 'pool_state', info: poolStateInfo, address: poolState },
    { name: 'hook_config', info: hookConfigInfo, address: hookConfig },
    { name: 'hook_whitelist', info: hookWhitelistInfo, address: hookWhitelist }
  ];
  
  let hasUninitializedInitAccount = false;
  for (const { name, info, address } of initAccounts) {
    const ownerStr = info?.owner.toBase58() || 'N/A';
    const isPoolOwned = info?.owner.equals(PROGRAM_IDS.pool) || false;
    const isSystemOwned = info?.owner.equals(SystemProgram.programId) || false;
    const isUninitialized = info && !isPoolOwned && !isSystemOwned;
    
    console.log(`[ensureMint]   ${name}: exists=${!!info}, owner=${ownerStr}, poolOwned=${isPoolOwned}, systemOwned=${isSystemOwned}, uninitialized=${isUninitialized}`);
    
    if (isUninitialized) {
      console.error(`[ensureMint] CRITICAL: ${name} (${address.toBase58()}) is uninitialized (owned by ${ownerStr})`);
      console.error(`[ensureMint] ${name} uses 'init' constraint - cannot initialize existing uninitialized accounts!`);
      hasUninitializedInitAccount = true;
    }
  }
  
  if (hasUninitializedInitAccount) {
    // CRITICAL: We cannot generate a new mint here because the mint is already registered!
    // The mint_mapping is registered with originMintKey, so we must use that for pool initialization.
    // If pool accounts are uninitialized, this indicates a previous failed pool initialization.
    // We should throw an error with clear instructions.
    throw new Error(
      `Cannot initialize pool for ${mintConfig.symbol}: Pool accounts (pool_state, hook_config, or hook_whitelist) are uninitialized, but mint is already registered with origin_mint ${originMintKey.toBase58()}. ` +
      `The mint_mapping PDA is derived from the registered origin_mint, so we cannot change it. ` +
      `This indicates a state inconsistency - the mint was registered but pool initialization failed previously. ` +
      `You may need to manually close the uninitialized accounts or use a different symbol. ` +
      `Uninitialized accounts: ${initAccounts.filter(a => a.info && !a.info.owner.equals(PROGRAM_IDS.pool) && !a.info.owner.equals(SystemProgram.programId)).map(a => a.name).join(', ')}`
    );
  }
  
  // CRITICAL: Check if pool is already initialized
  // If pool_state exists and is owned by pool program, the pool is already initialized
  // We should NOT try to initialize again, as init constraints will fail
  const poolAlreadyInitialized = poolStateInfo && poolStateInfo.owner.equals(PROGRAM_IDS.pool);
  
  // Check if commitment_tree exists but might have wrong discriminator
  // If so, we still need to call initialize_pool to let it reinitialize
  const commitmentTreeNeedsReinit = commitmentTreeInfo && commitmentTreeInfo.owner.equals(PROGRAM_IDS.pool);
  
  // Only initialize if pool doesn't exist OR if commitment tree needs reinit
  // BUT: If pool_state exists and is properly owned, we MUST NOT try to initialize
  // because init constraints will fail with 0x0
  const needsInit = !poolStateInfo && !poolAlreadyInitialized;
  
  console.log(`[ensureMint] Pool initialization check for ${mintConfig.symbol}: needsInit=${needsInit}, poolAlreadyInitialized=${poolAlreadyInitialized}, commitmentTreeNeedsReinit=${commitmentTreeNeedsReinit}`);
  
  if (needsInit || (commitmentTreeNeedsReinit && !poolAlreadyInitialized)) {
    // Always call initialize_pool - it will use init_if_needed to handle existing accounts
    const poolAccounts: Record<string, PublicKey> = {
      authority: ctx.payer.publicKey,
      pool_state: poolState,
      nullifier_set: nullifierSet,
      note_ledger: noteLedger,
      commitment_tree: commitmentTree,
      hook_config: hookConfig,
      hook_whitelist: hookWhitelist,
      vault_state: vaultState,
      origin_mint: originMintKey,
      mint_mapping: mintMapping,
      factory_state: factoryState,
      verifier_program: PROGRAM_IDS.verifier,
      verifying_key: verifyingKey.verifierState,
      payer: ctx.payer.publicKey,
      system_program: SystemProgram.programId,
      token_program: TOKEN_2022_PROGRAM_ID
    };
    if (twinMintKey) {
      poolAccounts.twin_mint = twinMintKey;
    }

    const computeBudgetIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })
    ];

    // CRITICAL: Final check right before pool initialization
    // Log all account states for debugging
    console.log(`[ensureMint] Pre-pool-init check for ${mintConfig.symbol}:`);
    console.log(`  pool_state: exists=${!!poolStateInfo}, owner=${poolStateInfo?.owner.toBase58() || 'N/A'}, dataLen=${poolStateInfo?.data.length || 0}`);
    console.log(`  hook_config: exists=${!!hookConfigInfo}, owner=${hookConfigInfo?.owner.toBase58() || 'N/A'}, dataLen=${hookConfigInfo?.data.length || 0}`);
    console.log(`  hook_whitelist: exists=${!!hookWhitelistInfo}, owner=${hookWhitelistInfo?.owner.toBase58() || 'N/A'}, dataLen=${hookWhitelistInfo?.data.length || 0}`);
    console.log(`  nullifier_set: exists=${!!nullifierSetInfo}, owner=${nullifierSetInfo?.owner.toBase58() || 'N/A'}, dataLen=${nullifierSetInfo?.data.length || 0}`);
    console.log(`  note_ledger: exists=${!!noteLedgerInfo}, owner=${noteLedgerInfo?.owner.toBase58() || 'N/A'}, dataLen=${noteLedgerInfo?.data.length || 0}`);
    console.log(`  commitment_tree: exists=${!!commitmentTreeInfo}, owner=${commitmentTreeInfo?.owner.toBase58() || 'N/A'}, dataLen=${commitmentTreeInfo?.data.length || 0}`);
    
    // Final safety check: abort if any init accounts are uninitialized
    if (poolStateInfo && !poolStateInfo.owner.equals(PROGRAM_IDS.pool) && !poolStateInfo.owner.equals(SystemProgram.programId)) {
      throw new Error(`ABORT: pool_state is uninitialized BEFORE pool init (owned by ${poolStateInfo.owner.toBase58()}). This should have been caught earlier.`);
    }
    if (hookConfigInfo && !hookConfigInfo.owner.equals(PROGRAM_IDS.pool) && !hookConfigInfo.owner.equals(SystemProgram.programId)) {
      throw new Error(`ABORT: hook_config is uninitialized BEFORE pool init (owned by ${hookConfigInfo.owner.toBase58()}). This should have been caught earlier.`);
    }
    if (hookWhitelistInfo && !hookWhitelistInfo.owner.equals(PROGRAM_IDS.pool) && !hookWhitelistInfo.owner.equals(SystemProgram.programId)) {
      throw new Error(`ABORT: hook_whitelist is uninitialized BEFORE pool init (owned by ${hookWhitelistInfo.owner.toBase58()}). This should have been caught earlier.`);
    }
    
    try {
      const signature = await sendInstruction(
        ctx,
        ctx.idls.pool,
        ctx.coders.pool,
        PROGRAM_IDS.pool,
        'initialize_pool',
        poolAccounts,
        {
          fee_bps: new BN(5),
          features: FEATURE_PRIVATE_TRANSFER_ENABLED | FEATURE_ALLOWANCES_ENABLED
        },
        [],
        computeBudgetIxs
      );
      console.log(`Initialised pool state ${poolState.toBase58()} (tx ${signature})`);
      await waitForAccount(connection, poolState, `Pool state for ${mintConfig.symbol}`);
      await waitForAccount(connection, nullifierSet, `Nullifier set for ${mintConfig.symbol}`);
      await waitForAccount(connection, noteLedger, `Note ledger for ${mintConfig.symbol}`);
      await waitForAccount(connection, commitmentTree, `Commitment tree for ${mintConfig.symbol}`);
      await waitForAccount(connection, hookConfig, `Hook config for ${mintConfig.symbol}`);
    } catch (error: any) {
      // If initialization fails due to account discriminator mismatch, 
      // try to close the problematic accounts and reinitialize
      if (error.message?.includes('AccountDiscriminatorMismatch') || 
          error.message?.includes('discriminator') ||
          error.message?.includes('AccountOwnedByWrongProgram')) {
        console.warn(`Account discriminator/owner mismatch detected for ${mintConfig.symbol}. Attempting to close and recreate accounts...`);
        
        // Try to close accounts that might have wrong discriminators
        // Note: We can't easily close PDAs, but we can try to reinitialize with init_if_needed
        // The program should handle this, but if it doesn't, we'll need to manually close
        try {
          // Check if note_ledger exists and has wrong owner
          const noteLedgerInfo = await connection.getAccountInfo(noteLedger);
          if (noteLedgerInfo && !noteLedgerInfo.owner.equals(PROGRAM_IDS.pool)) {
            console.warn(`Note ledger for ${mintConfig.symbol} has wrong owner: ${noteLedgerInfo.owner.toBase58()}, expected: ${PROGRAM_IDS.pool.toBase58()}`);
            // We can't close PDAs easily, so we'll just log and continue
            // The program's init_if_needed should handle reinitialization
          }
          
          // Retry initialization - the program's init_if_needed should handle it
          const retrySignature = await sendInstruction(
            ctx,
            ctx.idls.pool,
            ctx.coders.pool,
            PROGRAM_IDS.pool,
            'initialize_pool',
            poolAccounts,
            {
              fee_bps: new BN(5),
              features: FEATURE_PRIVATE_TRANSFER_ENABLED | FEATURE_ALLOWANCES_ENABLED
            },
            [],
            computeBudgetIxs
          );
          console.log(`Retried pool initialization for ${mintConfig.symbol} (tx ${retrySignature})`);
          await waitForAccount(connection, poolState, `Pool state for ${mintConfig.symbol}`);
          await waitForAccount(connection, nullifierSet, `Nullifier set for ${mintConfig.symbol}`);
          await waitForAccount(connection, noteLedger, `Note ledger for ${mintConfig.symbol}`);
          await waitForAccount(connection, commitmentTree, `Commitment tree for ${mintConfig.symbol}`);
          await waitForAccount(connection, hookConfig, `Hook config for ${mintConfig.symbol}`);
        } catch (retryError: any) {
          console.error(`Failed to retry initialization for ${mintConfig.symbol}:`, retryError.message);
          throw retryError;
        }
      } else {
        throw error;
      }
    }

    if (INDEXER_URL) {
      const commitmentTreeAccount = await connection.getAccountInfo(commitmentTree);
      if (commitmentTreeAccount) {
        const decodedTree = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
        const currentRootHex = bytesLEToCanonicalHex(decodedTree.currentRoot);
        await publishRoot(INDEXER_URL, originMintKey.toBase58(), currentRootHex);
      } else {
        console.warn(`[bootstrap] commitment tree account missing when publishing root for ${mintConfig.symbol}`);
      }
    }
  } else if (INDEXER_URL) {
    const commitmentTreeAccount = await connection.getAccountInfo(commitmentTree);
    if (commitmentTreeAccount) {
      const decodedTree = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
      const currentRootHex = bytesLEToCanonicalHex(decodedTree.currentRoot);
      await publishRoot(INDEXER_URL, originMintKey.toBase58(), currentRootHex);
    }
  }

  const resolvedPtknMint = ptknMintForConfig ?? twinMintKey;

  const lookupAddresses: PublicKey[] = [
    poolState,
    hookConfig,
    nullifierSet,
    commitmentTree,
    noteLedger,
    mintMapping,
    factoryState,
    vaultState,
    verifyingKey.verifierState,
    PROGRAM_IDS.factory,
    PROGRAM_IDS.verifier,
    PROGRAM_IDS.vault,
    TOKEN_PROGRAM_ID,
    vaultTokenAta
  ];
  if (resolvedPtknMint) {
    lookupAddresses.push(resolvedPtknMint);
  }
  const lookupTableKey = await ensureLookupTable(ctx, mintConfig.lookupTable ?? null, lookupAddresses);

  return {
    symbol: mintConfig.symbol,
    decimals: mintConfig.decimals,
    originMint: originMintKey.toBase58(),
    poolId: poolState.toBase58(),
    zTokenMint: resolvedPtknMint ? resolvedPtknMint.toBase58() : null,
    features: {
      ...mintConfig.features,
      zTokenEnabled: decodedMintMapping.has_ptkn
    },
    lookupTable: lookupTableKey.toBase58()
  };
}

export async function bootstrapPrivateDevnet() {
  const connection = new Connection(process.env.RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed');
  const payer = await loadKeypair(path.join(process.env.HOME ?? '.', '.config', 'solana', 'id.json'));

  const wallet: Wallet = {
    publicKey: payer.publicKey,
    payer,
    async signTransaction(tx) {
      if ('partialSign' in tx) {
        tx.partialSign(payer);
      } else if ('sign' in tx) {
        (tx as VersionedTransaction).sign([payer]);
      }
      return tx;
    },
    async signAllTransactions(txs) {
      txs.forEach((tx) => {
        if ('partialSign' in tx) {
          (tx as Transaction).partialSign(payer);
        } else if ('sign' in tx) {
          (tx as VersionedTransaction).sign([payer]);
        }
      });
      return txs;
    }
  };

  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const [factoryIdl, vaultIdl, poolIdl, verifierIdl] = await Promise.all([
    loadIdl('ptf_factory'),
    loadIdl('ptf_vault'),
    loadIdl('ptf_pool'),
    loadIdl('ptf_verifier_groth16')
  ]);

  const ctx: BootstrapContext = {
    provider,
    payer,
    idls: {
      factory: factoryIdl,
      vault: vaultIdl,
      pool: poolIdl,
      verifier: verifierIdl
    },
    coders: {
      factory: new BorshCoder(factoryIdl),
      vault: new BorshCoder(vaultIdl),
      pool: new BorshCoder(poolIdl),
      verifier: new BorshCoder(verifierIdl)
    }
  };

  await ensureFactory(ctx);

  const verifyingKeyMap = new Map<string, Awaited<ReturnType<typeof ensureVerifyingKey>>>();
  for (const [circuit, filename] of Object.entries(VERIFYING_KEY_CONFIG)) {
    const verifyingKeyPath = path.resolve(VERIFYING_KEY_DIR, filename);
    const result = await ensureVerifyingKey(ctx, circuit, 1, verifyingKeyPath);
    verifyingKeyMap.set(circuit, result);
  }

  const shieldVerifyingKey = verifyingKeyMap.get('shield');
  if (!shieldVerifyingKey) {
    throw new Error('Shield verifying key must be available before mint bootstrap.');
  }

  const seedMintsEnv = process.env.SEED_MINTS ?? 'true';
  const shouldSeedMints = seedMintsEnv.toLowerCase() !== 'false';
  if (!shouldSeedMints) {
    console.info('[bootstrap] SEED_MINTS disabled, skipping mint provisioning');
    return;
  }

  const mintsPath = process.env.MINTS_PATH ? path.resolve(process.env.MINTS_PATH) : DEFAULT_MINTS_PATH;
  const raw = await fs.readFile(mintsPath, 'utf8');
  const mintCatalog = JSON.parse(raw) as GeneratedMint[];
  const updated: GeneratedMint[] = [];

  // Ensure wSOL (native SOL mint) is registered
  const wsolMintMapping = PublicKey.findProgramAddressSync(
    [Buffer.from('map'), NATIVE_MINT.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  
  const wsolMappingInfo = await ctx.provider.connection.getAccountInfo(wsolMintMapping, 'confirmed');
  const wsolAlreadyRegistered = wsolMappingInfo && wsolMappingInfo.owner.equals(PROGRAM_IDS.factory);
  
  if (!wsolAlreadyRegistered) {
    console.log('[bootstrap] Registering wSOL (native SOL mint) in factory...');
    try {
      // Get wSOL mint info to verify decimals
      const wsolMintInfo = await ctx.provider.connection.getAccountInfo(NATIVE_MINT, 'confirmed');
      if (!wsolMintInfo) {
        console.warn('[bootstrap] wSOL mint account not found on-chain, skipping registration');
      } else {
        // wSOL has 9 decimals
        const wsolDecimals = 9;
        const factoryState = PublicKey.findProgramAddressSync(
          [Buffer.from('factory'), PROGRAM_IDS.factory.toBuffer()],
          PROGRAM_IDS.factory
        )[0];
        
        // Register wSOL manually by building the instruction directly
        // This bypasses Anchor's Interface constraint validation for optional accounts
        // Manual instruction building avoids the token_program validation issue
        
        // Discriminator for register_mint instruction (from IDL)
        const registerMintDiscriminator = Buffer.from([242, 43, 74, 162, 217, 214, 191, 171]);
        
        // Build instruction args manually (decimals, enable_ptkn, feature_flags, fee_bps_override)
        // Anchor serializes args in order: u8 (decimals), bool (enable_ptkn), Option<u8> (feature_flags), Option<u16> (fee_bps_override)
        const argsBuffer = Buffer.alloc(1 + 1 + 1 + 2); // u8 + bool + Option<u8> + Option<u16>
        let offset = 0;
        
        // decimals: u8
        argsBuffer.writeUInt8(wsolDecimals, offset);
        offset += 1;
        
        // enable_ptkn: bool (false = 0)
        argsBuffer.writeUInt8(0, offset);
        offset += 1;
        
        // feature_flags: Option<u8> (None = 0)
        argsBuffer.writeUInt8(0, offset);
        offset += 1;
        
        // fee_bps_override: Option<u16> (None = 0)
        argsBuffer.writeUInt16LE(0, offset);
        offset += 2;
        
        // Combine discriminator + args
        const instructionData = Buffer.concat([registerMintDiscriminator, argsBuffer]);
        
        // Build account metas manually in the exact order
        // Account order from IDL: factory_state, authority, mint_mapping, origin_mint, payer, ptkn_mint (optional), token_program (optional), rent, system_program
        // For optional accounts, we must include placeholders (Anchor validates all accounts in struct)
        // Use program ID as placeholder for optional accounts (Anchor's convention)
        const accountMetas: AccountMeta[] = [
          { pubkey: factoryState, isSigner: false, isWritable: true },           // factory_state
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },    // authority
          { pubkey: wsolMintMapping, isSigner: false, isWritable: true },        // mint_mapping
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },           // origin_mint
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },     // payer
          { pubkey: PROGRAM_IDS.factory, isSigner: false, isWritable: false },   // ptkn_mint (optional) - placeholder
          { pubkey: PROGRAM_IDS.factory, isSigner: false, isWritable: false },   // token_program (optional) - placeholder
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },    // rent
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } // system_program
        ];
        
        // Create the instruction manually
        const registerMintInstruction = new TransactionInstruction({
          programId: PROGRAM_IDS.factory,
          keys: accountMetas,
          data: instructionData
        });
        
        // Send and confirm
        await sendAndConfirm(ctx, [registerMintInstruction]);
        console.log('[bootstrap] ✓ Registered wSOL in factory (manual instruction)');
      }
    } catch (error) {
      console.warn('[bootstrap] Failed to register wSOL:', (error as Error).message);
      // Continue with other mints even if wSOL registration fails
    }
  } else {
    console.log('[bootstrap] wSOL already registered in factory');
  }

  for (const entry of mintCatalog) {
    const refreshed = await ensureMint(ctx, entry, shieldVerifyingKey);
    updated.push(refreshed);
  }

  await fs.writeFile(mintsPath, JSON.stringify(updated, null, 2));
  console.log(`\nUpdated mint catalogue written to ${mintsPath}`);
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  bootstrapPrivateDevnet().catch((error) => {
    console.error('Bootstrap failed', error);
    process.exit(1);
  });
}

