/* eslint-disable no-console */
import fs from 'fs/promises';
import path from 'path';
import { keccak_256 } from 'js-sha3';
import {
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
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { AnchorProvider, BN, BorshCoder, Idl, Wallet } from '@coral-xyz/anchor';

const PROGRAM_IDS = {
  factory: new PublicKey('4z618BY2dXGqAUiegqDt8omo3e81TSdXRHt64ikX1bTy'),
  vault: new PublicKey('9g6ZodQwxK8MN6MX3dbvFC3E7vGVqFtKZEHY7PByRAuh'),
  pool: new PublicKey('4Tx3v6is7qeVjdHvL3a16ggB9VVMBPVhpPSkUGoXZhre'),
  verifier: new PublicKey('Gm2KXvGhWrEeYERh3sxs1gwffMXeajVQXqY7CcBpm7Ua')
} as const;

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
  })()
};

const DEFAULT_MINTS_PATH = path.resolve(__dirname, '..', 'config', 'mints.generated.json');
const VERIFYING_KEY_DIR = path.resolve(__dirname, '..', '..', '..', 'circuits', 'keys');
const VERIFYING_KEY_CONFIG: Record<string, string> = {
  shield: 'shield.json',
  unshield: 'unshield.json'
};
const TARGET_IDL_DIR = path.resolve(__dirname, '..', '..', '..', 'target', 'idl');

async function loadIdl(name: string): Promise<Idl> {
  const target = path.join(TARGET_IDL_DIR, `${name}.json`);
  const payload = await fs.readFile(target, 'utf8');
  return JSON.parse(payload) as Idl;
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
  const data = coder.instruction.encode(name, args);
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
      return signature;
    }
    if (status?.err) {
      throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Transaction ${signature} timed out awaiting confirmation`);
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
  delayMs = 500
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const info = await connection.getAccountInfo(pubkey);
    if (info) {
      if (attempt > 0) {
        console.log(`${label} available after ${attempt + 1} attempts (${pubkey.toBase58()})`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} (${pubkey.toBase58()}) missing after initialization attempts`);
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
      timelock_seconds: new BN(0)
    }
  );
  console.log(`Initialised factory state ${factoryState.toBase58()}`);
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

  const contents = await fs.readFile(verifyingKeyPath);
  const hash = new Uint8Array(keccak_256.arrayBuffer(contents));
  console.log(`Using verifying key hash ${Buffer.from(hash).toString('hex')}`);

  await sendInstruction(
    ctx,
    ctx.idls.verifier,
    ctx.coders.verifier,
    PROGRAM_IDS.verifier,
    'initialize_verifying_key',
    {
      verifier_state: verifierState,
      authority: ctx.payer.publicKey,
      payer: ctx.payer.publicKey,
      system_program: SystemProgram.programId
    },
    {
      circuit_tag: padBytes(circuitTag),
      verifying_key_id: hash,
      hash,
      version,
      verifying_key_data: Buffer.from(contents)
    }
  );
  console.log(`Registered verifying key for circuit ${circuit} -> ${verifierState.toBase58()}`);
  return { verifierState, verifyingKeyId: hash, hash };
}

async function ensureMint(
  ctx: BootstrapContext,
  mintConfig: GeneratedMint,
  verifyingKey: { verifierState: PublicKey }
): Promise<GeneratedMint> {
  const { connection } = ctx.provider;
  let originMintKey = new PublicKey(mintConfig.originMint);
  const mintInfo = await connection.getAccountInfo(originMintKey);
  if (
    !mintInfo ||
    mintConfig.originMint.startsWith('Mint111') ||
    mintConfig.originMint.startsWith('Mint222')
  ) {
    const mint = await createMintAccount(ctx, mintConfig.decimals, ctx.payer.publicKey, ctx.payer.publicKey);
    originMintKey = mint.publicKey;
    const payerAta = await ensureAta(ctx, originMintKey, ctx.payer.publicKey);
    const mintAmount = 1_000_000 * 10 ** mintConfig.decimals;
    const mintIx = createMintToInstruction(originMintKey, payerAta, ctx.payer.publicKey, mintAmount);
    await sendAndConfirm(ctx, [mintIx]);
    console.log(`Created mint ${mintConfig.symbol}: ${originMintKey.toBase58()}`);
  }

  const factoryState = PublicKey.findProgramAddressSync(
    [Buffer.from('factory'), PROGRAM_IDS.factory.toBuffer()],
    PROGRAM_IDS.factory
  )[0];
  const mintMapping = PublicKey.findProgramAddressSync(
    [Buffer.from('map'), originMintKey.toBuffer()],
    PROGRAM_IDS.factory
  )[0];

  const vaultState = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), originMintKey.toBuffer()],
    PROGRAM_IDS.vault
  )[0];
  const poolState = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const nullifierSet = PublicKey.findProgramAddressSync(
    [Buffer.from('nulls'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const noteLedger = PublicKey.findProgramAddressSync(
    [Buffer.from('notes'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const commitmentTree = PublicKey.findProgramAddressSync(
    [Buffer.from('tree'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];
  const hookConfig = PublicKey.findProgramAddressSync(
    [Buffer.from('hooks'), originMintKey.toBuffer()],
    PROGRAM_IDS.pool
  )[0];

  let ptknMintForConfig: PublicKey | null = null;

  if (!(await connection.getAccountInfo(mintMapping))) {
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
    await waitForAccount(connection, mintMapping, `Mint mapping for ${mintConfig.symbol}`);
    if (ptknMintKeypair) {
      ptknMintForConfig = ptknMintKeypair.publicKey;
    }
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
        system_program: SystemProgram.programId
      },
      { pool_authority: poolState }
    );
    console.log(`Initialised vault state ${vaultState.toBase58()} (tx ${signature})`);
    await waitForAccount(connection, vaultState, `Vault state for ${mintConfig.symbol}`);
  }

  await ensureAta(ctx, originMintKey, vaultState, true);

  const mintMappingInfo = await connection.getAccountInfo(mintMapping);
  if (!mintMappingInfo) {
    throw new Error(`Mint mapping account missing after registration for ${mintConfig.symbol}`);
  }
  const decodedMintMapping = ctx.coders.factory.accounts.decode('MintMapping', mintMappingInfo.data) as {
    ptkn_mint: Uint8Array;
    has_ptkn: boolean;
    features: { bits?: number } | number;
  };

  const twinMintKey = decodedMintMapping.has_ptkn ? new PublicKey(decodedMintMapping.ptkn_mint) : null;

  if (!(await connection.getAccountInfo(poolState))) {
    const poolAccounts: Record<string, PublicKey> = {
      authority: ctx.payer.publicKey,
      pool_state: poolState,
      nullifier_set: nullifierSet,
      note_ledger: noteLedger,
      commitment_tree: commitmentTree,
      hook_config: hookConfig,
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

    const signature = await sendInstruction(
      ctx,
      ctx.idls.pool,
      ctx.coders.pool,
      PROGRAM_IDS.pool,
      'initialize_pool',
      poolAccounts,
      {
        fee_bps: new BN(5),
        features: 0
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
  }

  const resolvedPtknMint = ptknMintForConfig ?? twinMintKey;

  return {
    symbol: mintConfig.symbol,
    decimals: mintConfig.decimals,
    originMint: originMintKey.toBase58(),
    poolId: poolState.toBase58(),
    zTokenMint: resolvedPtknMint ? resolvedPtknMint.toBase58() : null,
    features: {
      ...mintConfig.features,
      zTokenEnabled: decodedMintMapping.has_ptkn
    }
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

  const mintsPath = process.env.MINTS_PATH ? path.resolve(process.env.MINTS_PATH) : DEFAULT_MINTS_PATH;
  const raw = await fs.readFile(mintsPath, 'utf8');
  const mintCatalog = JSON.parse(raw) as GeneratedMint[];
  const updated: GeneratedMint[] = [];

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

