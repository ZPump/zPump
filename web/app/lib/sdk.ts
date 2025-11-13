import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
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
  POOL_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  FACTORY_PROGRAM_ID
} from './onchain/programIds';
import {
  deriveCommitmentTree,
  deriveHookConfig,
  deriveNullifierSet,
  deriveNoteLedger,
  deriveVaultState,
  deriveVerifyingKey,
  deriveMintMapping,
  deriveFactoryState
} from './onchain/pdas';
import { decodeCommitmentTree } from './onchain/commitmentTree';
import { bytesToBigIntLE, hexToBytes } from './onchain/utils';
import { poseidonHashMany } from './onchain/poseidon';
import { ProofResponse } from './proofClient';
import poolIdl from '../idl/ptf_pool.json';
import factoryIdl from '../idl/ptf_factory.json';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction
} from '@solana/spl-token';

const DEFAULT_SIGNATURE_TIMEOUT_MS = 60_000;
const SIGNATURE_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}

interface UnwrapParams extends BaseParams {
  destination: string;
  mode: 'origin' | 'ztkn' | 'ptkn';
  proof: ProofResponse;
  lookupTable?: string;
  twinMint?: string;
}

interface DecodedProofPayload {
  proof: Buffer;
  publicInputs: Buffer;
  fields: Uint8Array[];
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
    const bytes = hexToBytes(input, 32);
    if (bytes.length !== 32) {
      throw new Error(`Public input at index ${index} must be 32 bytes`);
    }
    return bytes;
  });

  const flattened = Buffer.concat(
    fieldBytes.map((entry) => {
      const be = Buffer.from(entry);
      be.reverse();
      return be;
    })
  );
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

function assertWallet(wallet: WalletContextState): asserts wallet is WalletContextState & {
  publicKey: NonNullable<WalletContextState['publicKey']>;
  sendTransaction: NonNullable<WalletContextState['sendTransaction']>;
} {
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error('Wallet not connected');
  }
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
  const vaultState = deriveVaultState(originMintKey);
  const verifyingKey = deriveVerifyingKey();
  const twinMintKey = params.twinMint ? new PublicKey(params.twinMint) : null;

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
    if (computeLimitEnv) {
      const parsed = Number(computeLimitEnv);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
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

  const poolCoder = new BorshCoder(poolIdl as Idl);
  const decodedProof = decodeProofPayload(params.proof);
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    // eslint-disable-next-line no-console
    console.info('[wrap] current root', Buffer.from(treeState.currentRoot).toString('hex'));
    // eslint-disable-next-line no-console
    console.info('[wrap] old root field', Buffer.from(decodedProof.fields[0] ?? []).toString('hex'));
    if (decodedProof.fields[0]) {
      const reversed = Buffer.from(decodedProof.fields[0]).slice().reverse();
      // eslint-disable-next-line no-console
      console.info('[wrap] old root field (be)', reversed.toString('hex'));
    }
    if (decodedProof.fields[1]) {
      const newRootBe = Buffer.from(decodedProof.fields[1]).slice().reverse();
      // eslint-disable-next-line no-console
      console.info('[wrap] new root field (be)', newRootBe.toString('hex'));
    }
  }
  const shieldArgs = {
    amount_commit: Array.from(amountCommitmentBytes),
    amount: new BN(amount.toString()),
    proof: Buffer.from(decodedProof.proof),
    public_inputs: Buffer.from(decodedProof.publicInputs)
  };
  const shieldData = poolCoder.instruction.encode('shield', { args: shieldArgs });
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
      publicInputs: decodedProof.publicInputs.length
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

  const keys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: nullifierSet, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedger, isSigner: false, isWritable: true },
    { pubkey: vaultState, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }
  ];

  if (twinMintKey) {
    keys.push({ pubkey: twinMintKey, isSigner: false, isWritable: true });
  } else {
    // Anchor treats an optional account as `None` when the slot equals the program id.
    keys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  keys.push(
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
  );

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys,
      data: shieldData
    })
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = wallet.publicKey;
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
  const vaultStateKey = deriveVaultState(originMintKey);
  const mintMappingKey = deriveMintMapping(originMintKey);
  const factoryStateKey = deriveFactoryState();
  const verifyingKey = deriveVerifyingKey();

  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey);
  if (!commitmentTreeAccount) {
    throw new Error('Commitment tree account missing on devnet');
  }

  const decodedTree = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));

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

  const canonicalHex = (bytes: Uint8Array) => Buffer.from(bytes).slice().reverse().toString('hex');
  const littleEndianHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

  const oldRootCanonical = canonicalHex(oldRootBytes);
  const currentRootCanonical = canonicalHex(decodedTree.currentRoot);
  if (oldRootCanonical !== currentRootCanonical) {
    console.warn('[unwrap] root mismatch', {
      oldRootLe: littleEndianHex(oldRootBytes),
      currentRootLe: littleEndianHex(decodedTree.currentRoot),
      oldRootBe: oldRootCanonical,
      currentRootBe: currentRootCanonical
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

  const factoryCoder = new BorshCoder(factoryIdl as Idl);

  let twinMintKey: PublicKey | null = params.twinMint ? new PublicKey(params.twinMint) : null;
  if (mode === 'ptkn') {
    const mintMappingAccount = await connection.getAccountInfo(mintMappingKey);
    if (!mintMappingAccount) {
      throw new Error('Mint mapping account missing on devnet');
    }
    const decodedMintMapping = factoryCoder.accounts.decode('MintMapping', mintMappingAccount.data);
    if (!decodedMintMapping.hasPtkn) {
      throw new Error('Twin mint is not enabled for this origin mint.');
    }
    const candidate = new PublicKey(decodedMintMapping.ptknMint);
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

  const redeemToTwin = mode === 'ptkn';
  if (!redeemToTwin) {
    twinMintKey = null;
  } else if (!twinMintKey) {
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

  const instructionName = mode === 'ptkn' ? 'unshield_to_ptkn' : 'unshield_to_origin';
  const unshieldData = poolCoder.instruction.encode(instructionName, { args: unshieldArgs });

  const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
    { pubkey: poolStateKey, isSigner: false, isWritable: true },
    { pubkey: hookConfigKey, isSigner: false, isWritable: false },
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
    keys.push({ pubkey: twinMintKey, isSigner: false, isWritable: redeemToTwin });
  } else {
    // Anchor treats an optional account as `None` when the slot equals the program id.
    keys.push({ pubkey: POOL_PROGRAM_ID, isSigner: false, isWritable: false });
  }

  keys.push(
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: factoryStateKey, isSigner: false, isWritable: false },
    { pubkey: FACTORY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
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

export async function resolvePublicKey(maybeKey: string | undefined, fallback: PublicKey): Promise<PublicKey> {
  if (!maybeKey) {
    return fallback;
  }
  return new PublicKey(maybeKey);
}
