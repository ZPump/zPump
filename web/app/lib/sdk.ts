import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { WalletContextState } from '@solana/wallet-adapter-react';
import { BorshCoder, BN, Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  POOL_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  VERIFIER_PROGRAM_ID
} from './onchain/programIds';
import {
  deriveCommitmentTree,
  deriveHookConfig,
  deriveNullifierSet,
  deriveNoteLedger,
  deriveVaultState,
  deriveVerifyingKey
} from './onchain/pdas';
import { decodeCommitmentTree, computeNextCommitmentTreeState } from './onchain/commitmentTree';
import { bytesToBigIntLE, hexToBytes } from './onchain/utils';
import { poseidonHashMany } from './onchain/poseidon';
import { ProofResponse } from './proofClient';
import poolIdl from '../idl/ptf_pool.json';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';

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
}

interface UnwrapParams extends BaseParams {
  destination: string;
  mode: 'origin' | 'ztkn';
  proof: ProofResponse;
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

  const commitmentTreeAccount = await connection.getAccountInfo(commitmentTreeKey);
  if (!commitmentTreeAccount) {
    throw new Error('Commitment tree account missing on devnet');
  }

  const treeState = decodeCommitmentTree(new Uint8Array(commitmentTreeAccount.data));
  const recipientKey = params.recipient ? new PublicKey(params.recipient) : wallet.publicKey;
  const depositId = BigInt(params.depositId);
  const blinding = BigInt(params.blinding);
  const amount = params.amount;

  const commitmentBytes =
    params.commitmentHint && params.commitmentHint !== '0x0'
      ? hexToBytes(params.commitmentHint, 32)
      : await poseidonHashMany([
          amount,
          bytesToBigIntLE(recipientKey.toBuffer()),
          depositId,
          bytesToBigIntLE(poolState.toBuffer()),
          blinding
        ]);

  const amountCommitmentBytes = await poseidonHashMany([amount, blinding]);

  const { newRoot } = await computeNextCommitmentTreeState(treeState, commitmentBytes, amountCommitmentBytes);

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
  const proofBytes =
    params.proof && params.proof.proof ? Uint8Array.from(Buffer.from(params.proof.proof, 'base64')) : new Uint8Array();
  const shieldArgs = {
    newRoot: Array.from(newRoot),
    commitment: Array.from(commitmentBytes),
    amountCommit: Array.from(amountCommitmentBytes),
    amount: new BN(amount.toString()),
    proof: Buffer.from(proofBytes),
    publicInputs: Buffer.from([])
  };
  const shieldData = poolCoder.instruction.encode('shield', { args: shieldArgs });

  const keys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: nullifierSet, isSigner: false, isWritable: true },
    { pubkey: commitmentTreeKey, isSigner: false, isWritable: true },
    { pubkey: noteLedger, isSigner: false, isWritable: true },
    { pubkey: vaultState, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
    { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // twin mint placeholder
    { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: verifyingKey, isSigner: false, isWritable: false },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: originMintKey, isSigner: false, isWritable: false },
    { pubkey: VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
  ];

  instructions.push(
    new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys,
      data: shieldData
    })
  );

  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = wallet.publicKey;

  const signature = await wallet.sendTransaction(transaction, connection, { skipPreflight: true });
  return signature;
}

export async function unwrap(params: UnwrapParams): Promise<string> {
  void params;
  throw new Error('Unshield flow is not yet wired to the devnet program.');
}

export async function resolvePublicKey(maybeKey: string | undefined, fallback: PublicKey): Promise<PublicKey> {
  if (!maybeKey) {
    return fallback;
  }
  return new PublicKey(maybeKey);
}
