import { Buffer } from 'buffer';
import { createHash } from 'crypto';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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
  deriveFactoryState,
  deriveShieldClaim
} from './onchain/pdas';
import { decodeCommitmentTree } from './onchain/commitmentTree';
import {
  bytesToBigIntLE,
  canonicalHexToBytesLE,
  bytesLEToCanonicalHex,
  canonicalizeHex
} from './onchain/utils';
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

const poolCoder = new BorshCoder(poolIdl as Idl);

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
  const shieldClaim = deriveShieldClaim(poolState);
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
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
  );

  const shieldInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: shieldKeys,
    data: shieldData
  });

  const finalizeTreeKeys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: shieldClaim, isSigner: false, isWritable: true }
  ];

  const finalizeLedgerKeys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: noteLedger, isSigner: false, isWritable: true },
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

  const finalizeLedgerInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: finalizeLedgerKeys,
    data: finalizeLedgerData
  });

  const checkInvariantInstruction = new TransactionInstruction({
    programId: POOL_PROGRAM_ID,
    keys: checkInvariantKeys,
    data: checkInvariantData
  });

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const shieldTransaction = new Transaction().add(...instructions, shieldInstruction);
  shieldTransaction.feePayer = wallet.publicKey;
  shieldTransaction.recentBlockhash = latestBlockhash.blockhash;

  const shieldSignature = await wallet.sendTransaction(shieldTransaction, connection, {
    skipPreflight: false
  });

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
  while (claimState.status === SHIELD_CLAIM_STATUS.PENDING_TREE) {
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

  const finalizeLedgerInstructions: TransactionInstruction[] = [];
  if (resolvedComputeLimit > 0) {
    finalizeLedgerInstructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: resolvedComputeLimit }));
  }
  finalizeLedgerInstructions.push(finalizeLedgerInstruction);

  const finalizeLedgerBlockhash = await connection.getLatestBlockhash('confirmed');
  const finalizeLedgerTransaction = new Transaction().add(...finalizeLedgerInstructions);
  finalizeLedgerTransaction.feePayer = wallet.publicKey;
  finalizeLedgerTransaction.recentBlockhash = finalizeLedgerBlockhash.blockhash;

  const finalizeLedgerSignature = await wallet.sendTransaction(finalizeLedgerTransaction, connection, {
    skipPreflight: false
  });

  await waitForSignatureConfirmation(
    connection,
    finalizeLedgerSignature,
    finalizeLedgerBlockhash.blockhash,
    finalizeLedgerBlockhash.lastValidBlockHeight
  );
  if (process.env.NEXT_PUBLIC_DEBUG_WRAP === 'true') {
    console.info('[wrap] shield finalize_ledger signature', finalizeLedgerSignature);
  }

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
  const vaultStateKey = deriveVaultState(originMintKey);
  const mintMappingKey = deriveMintMapping(originMintKey);
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

  const factoryCoder = new BorshCoder(factoryIdl as Idl);

  let twinMintKey: PublicKey | null = params.twinMint ? new PublicKey(params.twinMint) : null;
  const mintMappingAccount = await connection.getAccountInfo(mintMappingKey);
  if (!mintMappingAccount) {
    throw new Error('Mint mapping account missing on devnet');
  }
  const decodedMintMapping = factoryCoder.accounts.decode('MintMapping', mintMappingAccount.data);
  if (decodedMintMapping.hasPtkn) {
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

  if (mode === 'ptkn' && !decodedMintMapping.hasPtkn) {
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
    if (unwrapComputeLimitEnv) {
      const parsed = Number(unwrapComputeLimitEnv);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
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
  } else {
    keys.push({
      pubkey: POOL_PROGRAM_ID,
      isSigner: false,
      isWritable: false
    });
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
